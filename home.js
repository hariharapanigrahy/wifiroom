// Smart-home glue. Each driver wraps an existing package (or a device's documented local HTTP API)
// and registers "entities" with the same small interface, so the room, the UI and the MCP tools
// can treat a Kasa plug, a Hue bulb and a Home Assistant air conditioner the same way.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client: KasaClient } = require('tplink-smarthome-api');
const { v3: hue } = require('node-hue-api');
const LifxClient = require('lifx-lan-client').Client;
const onvif = require('onvif');

// id -> { id, name, type, source, ip, state, brightness, temperature, current, features, ops }
// `ops` holds the driver's functions and never leaves this module.
const entities = new Map();
let settings = {};
let settingsFile;
let changed = () => {};
let haStatus = { status: 'off' };

// ---- settings: Home Assistant URL + token, Hue usernames, ONVIF login. Stays on this computer. ----
function loadSettings(dataDir) {
  settingsFile = path.join(dataDir, 'home.json');
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { settings = {}; }
}
function saveSettings() {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.chmodSync(settingsFile, 0o600); // `mode` only applies when the file is first created
}

const set = (e) => { entities.set(e.id, { ...entities.get(e.id), ...e }); changed(); };
const drop = (prefix) => { for (const id of entities.keys()) if (id.startsWith(prefix)) entities.delete(id); changed(); };
const pct = (v, max) => Math.round((Number(v) / max) * 100);
const warn = (where) => (err) => console.error(`[home] ${where}: ${err?.message ?? err}`);

// Colors arrive as "#ff8800", "ff8800" or a plain name from a voice assistant.
const COLORS = { red: 'ff0000', green: '00ff00', blue: '0000ff', white: 'ffffff', 'warm white': 'ffd8a8', yellow: 'ffff00', orange: 'ff8000', purple: '8000ff', pink: 'ff69b4', cyan: '00ffff', magenta: 'ff00ff' };
function parseColor(value) {
  const s = String(value ?? '').trim().toLowerCase();
  const hex = COLORS[s] ?? s.replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new Error(`Unknown color "${value}". Use a name like "red" or a hex code like #ff8800`);
  const n = parseInt(hex, 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
}
// Kasa bulbs want hue/saturation rather than RGB.
function rgbToHsv({ r, g, b }) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: Math.round((h * 60 + 360) % 360), saturation: max ? Math.round((d / max) * 100) : 0, value: Math.round((max / 255) * 100) };
}

// ---- TP-Link Kasa plugs, switches and bulbs (tplink-smarthome-api, local UDP/TCP) ----
function startKasa() {
  const client = new KasaClient({ logLevel: 'silent' });
  client.on('error', warn('kasa'));
  const add = (dev) => {
    const isBulb = dev.deviceType === 'bulb';
    const light = () => dev.lighting?.lightState ?? {};
    const update = () => set({
      id: `kasa:${dev.id}`, name: dev.alias, source: 'kasa', ip: dev.host,
      type: isBulb ? 'light' : dev.supportsDimmer ? 'light' : 'plug',
      state: (isBulb ? light().on_off : dev.relayState) ? 'on' : 'off',
      brightness: isBulb ? light().brightness ?? light().dft_on_state?.brightness : dev.supportsDimmer ? dev.sysInfo.brightness : undefined,
      features: ['power', ...((isBulb && dev.supportsBrightness) || dev.supportsDimmer ? ['brightness'] : []), ...(isBulb && dev.supportsColor ? ['color'] : [])],
      ops: {
        power: (on) => dev.setPowerState(on),
        toggle: () => dev.togglePowerState(),
        brightness: (v) => (isBulb ? dev.lighting.setLightState({ on_off: 1, brightness: v }) : dev.dimmer.setBrightness(v)),
        color: (c) => { const { hue: h, saturation } = rgbToHsv(c); return dev.lighting.setLightState({ on_off: 1, hue: h, saturation, color_temp: 0 }); },
        refresh: () => dev.getSysInfo(),
      },
    });
    update();
    for (const evt of ['power-update', 'lightstate-update', 'brightness-update']) dev.on(evt, update);
  };
  client.on('device-new', add);
  client.on('device-online', (dev) => entities.has(`kasa:${dev.id}`) || add(dev));
  client.startDiscovery({ discoveryInterval: 30_000 });
}

// ---- Philips Hue bridge (node-hue-api). Pairing needs the bridge's button pressed. ----
const bridges = new Map(); // bridge id -> ip
const hueApis = new Map(); // bridge id -> connected api
function startHue(bonjour) {
  bonjour.find({ type: 'hue' }, (svc) => {
    const ip = (svc.addresses ?? []).find((a) => a.includes('.'));
    const bridgeId = String(svc.txt?.bridgeid ?? ip).toLowerCase();
    if (!ip || bridges.get(bridgeId) === ip) return;
    bridges.set(bridgeId, ip);
    hueApis.delete(bridgeId);
    connectHue(bridgeId).catch(warn('hue'));
  });
  setInterval(() => { for (const id of bridges.keys()) if (settings.hue?.[id]) connectHue(id).catch(warn('hue')); }, 15_000);
}

async function connectHue(bridgeId) {
  const ip = bridges.get(bridgeId), username = settings.hue?.[bridgeId];
  if (!username) {
    return set({ id: `hue:${bridgeId}`, name: 'Philips Hue bridge', source: 'hue', ip, type: 'bridge', state: 'needs pairing', features: ['pair'], ops: { pair: () => pairHue(bridgeId) } });
  }
  entities.delete(`hue:${bridgeId}`);
  if (!hueApis.has(bridgeId)) hueApis.set(bridgeId, await hue.api.createLocal(ip).connect(username));
  const api = hueApis.get(bridgeId);
  for (const l of await api.lights.getAll()) {
    const caps = l.capabilities?.control ?? {};
    set({
      id: `hue:${bridgeId}:${l.id}`, name: l.name, source: 'hue', ip, type: 'light',
      state: l.state.on ? 'on' : 'off', brightness: l.state.bri !== undefined ? pct(l.state.bri, 254) : undefined,
      features: ['power', ...(l.state.bri !== undefined ? ['brightness'] : []), ...(caps.colorgamut ? ['color'] : [])],
      ops: {
        power: (on) => api.lights.setLightState(l.id, new hue.lightStates.LightState()[on ? 'on' : 'off']()),
        brightness: (v) => api.lights.setLightState(l.id, new hue.lightStates.LightState().on().brightness(v)),
        color: ({ r, g, b }) => api.lights.setLightState(l.id, new hue.lightStates.LightState().on().rgb(r, g, b)),
        refresh: () => connectHue(bridgeId),
      },
    });
  }
}

async function pairHue(bridgeId) {
  const api = await hue.api.createLocal(bridges.get(bridgeId)).connect();
  try {
    const user = await api.users.createUser('wifiroom', os.hostname().slice(0, 19));
    (settings.hue ??= {})[bridgeId] = user.username;
    saveSettings();
  } catch (err) {
    if (/link button/i.test(err.message)) throw new Error('Press the round button on the Hue bridge, then try again within 30 seconds');
    throw err;
  }
  await connectHue(bridgeId);
  return 'Paired with the Hue bridge';
}

// ---- Shelly relays, plugs, dimmers, roller shutters (documented local HTTP API) ----
// No maintained npm package covers both Gen1 and Gen2+ devices; their local API is a few plain GET URLs.
const shellyGet = (ip, p) => fetch(`http://${ip}${p}`, { signal: AbortSignal.timeout(4000) }).then((r) => {
  if (r.status === 401) throw new Error('This Shelly has a password set; turn off "restrict login" or control it through Home Assistant');
  if (!r.ok) throw new Error(`Shelly replied ${r.status}`);
  return r.json();
});
const shellies = new Map(); // ip -> name
function startShelly(bonjour) {
  const found = (svc) => {
    const ip = (svc.addresses ?? []).find((a) => a.includes('.'));
    if (!ip || shellies.has(ip)) return;
    shellies.set(ip, svc.name);
    refreshShelly(ip).catch(warn('shelly'));
  };
  bonjour.find({ type: 'shelly' }, found); // Gen2+ devices
  bonjour.find({ type: 'http' }, (svc) => /^shelly/i.test(svc.name) && found(svc)); // Gen1 devices only announce _http
  setInterval(() => { for (const ip of shellies.keys()) refreshShelly(ip).catch(() => {}); }, 30_000);
}

async function refreshShelly(ip) {
  const info = await shellyGet(ip, '/shelly');
  const base = shellies.get(ip);
  const refresh = () => refreshShelly(ip);
  if (info.gen >= 2) {
    const status = await shellyGet(ip, '/rpc/Shelly.GetStatus');
    for (const [key, s] of Object.entries(status)) {
      const [kind, n] = key.split(':');
      const rpc = (method, q = '') => shellyGet(ip, `/rpc/${method}?id=${n}${q}`);
      if (kind === 'switch') set({ id: `shelly:${ip}:${key}`, name: `${base} ${n}`, source: 'shelly', ip, type: 'plug', state: s.output ? 'on' : 'off', features: ['power'], ops: { power: (on) => rpc('Switch.Set', `&on=${on}`), toggle: () => rpc('Switch.Toggle'), refresh } });
      if (kind === 'light') set({ id: `shelly:${ip}:${key}`, name: `${base} ${n}`, source: 'shelly', ip, type: 'light', state: s.output ? 'on' : 'off', brightness: s.brightness, features: ['power', 'brightness'], ops: { power: (on) => rpc('Light.Set', `&on=${on}`), toggle: () => rpc('Light.Toggle'), brightness: (v) => rpc('Light.Set', `&on=true&brightness=${v}`), refresh } });
      if (kind === 'cover') set({ id: `shelly:${ip}:${key}`, name: `${base} ${n}`, source: 'shelly', ip, type: 'cover', state: s.state, features: ['power'], ops: { power: (open) => rpc(open ? 'Cover.Open' : 'Cover.Close'), refresh } });
    }
  } else {
    const status = await shellyGet(ip, '/status');
    (status.relays ?? []).forEach((s, n) => set({ id: `shelly:${ip}:relay${n}`, name: `${base} ${n}`, source: 'shelly', ip, type: 'plug', state: s.ison ? 'on' : 'off', features: ['power'], ops: { power: (on) => shellyGet(ip, `/relay/${n}?turn=${on ? 'on' : 'off'}`), toggle: () => shellyGet(ip, `/relay/${n}?turn=toggle`), refresh } }));
    (status.lights ?? []).forEach((s, n) => set({ id: `shelly:${ip}:light${n}`, name: `${base} ${n}`, source: 'shelly', ip, type: 'light', state: s.ison ? 'on' : 'off', brightness: s.brightness, features: ['power', 'brightness'], ops: { power: (on) => shellyGet(ip, `/light/${n}?turn=${on ? 'on' : 'off'}`), brightness: (v) => shellyGet(ip, `/light/${n}?turn=on&brightness=${v}`), refresh } }));
    (status.rollers ?? []).forEach((s, n) => set({ id: `shelly:${ip}:roller${n}`, name: `${base} ${n}`, source: 'shelly', ip, type: 'cover', state: s.state, features: ['power'], ops: { power: (open) => shellyGet(ip, `/roller/${n}?go=${open ? 'open' : 'close'}`), refresh } }));
  }
}

// ---- LIFX bulbs (lifx-lan-client, local UDP) ----
function startLifx() {
  const client = new LifxClient();
  client.on('error', warn('lifx'));
  const cb = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
  const refresh = (light) => cb((done) => light.getState(done)).then((st) => set({
    id: `lifx:${light.id}`, name: st.label || 'LIFX bulb', source: 'lifx', ip: light.address, type: 'light',
    state: st.power ? 'on' : 'off', brightness: st.color?.brightness, features: ['power', 'brightness', 'color'],
    ops: {
      power: (on) => cb((done) => light[on ? 'on' : 'off'](300, done)),
      brightness: (v) => cb((done) => light.getState((err, s) => (err ? done(err) : light.color(s.color.hue, s.color.saturation, v, s.color.kelvin, 300, done)))),
      color: ({ r, g, b }) => cb((done) => light.colorRgb(r, g, b, 300, done)),
      refresh: () => refresh(light),
    },
  }));
  client.on('light-new', (light) => refresh(light).catch(warn('lifx')));
  client.on('light-offline', (light) => { entities.delete(`lifx:${light.id}`); changed(); });
  client.init({ discoveryInterval: 30_000 }, (err) => err && warn('lifx')(err));
  setInterval(() => { for (const l of client.lights()) refresh(l).catch(() => {}); }, 60_000);
}

// ---- ONVIF IP cameras (onvif): WS-Discovery multicast, then a snapshot on request ----
function startOnvif() {
  onvif.Discovery.on('error', () => {}); // non-camera devices answer with junk; ignore it
  const probe = () => onvif.Discovery.probe({ timeout: 5000 }, (err, cams) => {
    for (const cam of cams ?? []) {
      set({ id: `onvif:${cam.hostname}`, name: `Camera ${cam.hostname}`, source: 'onvif', ip: cam.hostname, type: 'camera', state: 'online', features: ['snapshot'], ops: { snapshot: () => onvifSnapshot(cam) } });
    }
  });
  probe();
  setInterval(probe, 5 * 60_000);
}

async function onvifSnapshot({ hostname, port }) {
  const { username, password } = settings.onvif ?? {};
  const cam = await new Promise((resolve, reject) => {
    const c = new onvif.Cam({ hostname, port, username, password, timeout: 5000 }, (err) => (err ? reject(new Error(username ? `Camera refused the login: ${err.message}` : 'This camera needs a login. Add it under 🏡 Home → Settings')) : resolve(c)));
  });
  const { uri } = await new Promise((resolve, reject) => cam.getSnapshotUri((err, res) => (err ? reject(err) : resolve(res))));
  // Many cameras accept HTTP Basic auth for snapshots; those that insist on Digest get the URL instead.
  const headers = username ? { Authorization: `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}` } : {};
  const res = await fetch(uri, { headers, signal: AbortSignal.timeout(6000) }).catch(() => null);
  const mime = res?.headers.get('content-type') ?? '';
  if (res?.ok && mime.startsWith('image/')) return { mime, data: Buffer.from(await res.arrayBuffer()).toString('base64') };
  return { url: uri };
}

// ---- Home Assistant: the catch-all (home-assistant-js-websocket + REST for camera images) ----
let ha = null;
const HA_TYPES = { light: 'light', switch: 'switch', climate: 'climate', cover: 'cover', camera: 'camera' };

async function startHomeAssistant() {
  ha?.close();
  ha = null;
  drop('ha:');
  const { url, token } = settings.homeAssistant ?? {};
  if (!url || !token) { haStatus = { status: 'off' }; return changed(); }
  // Node 22+ has a built-in WebSocket; Node 20 needs the `ws` package.
  globalThis.WebSocket ??= (await import('ws')).default;
  const { createConnection, createLongLivedTokenAuth, subscribeEntities, callService, ERR_INVALID_AUTH } = await import('home-assistant-js-websocket');
  haStatus = { status: 'connecting' };
  changed();
  try {
    ha = await createConnection({ auth: createLongLivedTokenAuth(url.replace(/\/+$/, ''), token) });
  } catch (code) {
    haStatus = { status: 'error', error: code === ERR_INVALID_AUTH ? 'Home Assistant rejected the token' : `Can't reach Home Assistant at ${url}` };
    return changed();
  }
  haStatus = { status: 'connected' };
  ha.addEventListener('disconnected', () => { haStatus = { status: 'reconnecting' }; changed(); });
  ha.addEventListener('ready', () => { haStatus = { status: 'connected' }; changed(); });
  const base = url.replace(/\/+$/, '');
  subscribeEntities(ha, (states) => { try { showHaEntities(states); } catch (err) { warn('homeassistant')(err); } });

  function showHaEntities(states) {
    drop('ha:');
    for (const [entityId, st] of Object.entries(states)) {
      const domain = entityId.split('.')[0], type = HA_TYPES[domain];
      if (!type || st.state === 'unavailable') continue;
      const a = st.attributes, call = (service, data = {}) => callService(ha, domain, service, data, { entity_id: entityId });
      const isLight = domain === 'light', isCover = domain === 'cover';
      entities.set(`ha:${entityId}`, {
        id: `ha:${entityId}`, name: a.friendly_name || entityId, source: 'homeassistant', type, state: st.state,
        brightness: isLight && a.brightness != null ? pct(a.brightness, 255) : undefined,
        temperature: a.temperature ?? undefined, current: a.current_temperature ?? undefined, unit: a.temperature != null ? '°' : undefined,
        features: type === 'camera' ? ['snapshot'] : ['power', ...(isLight ? ['brightness', 'color'] : []), ...(domain === 'climate' ? ['temperature'] : [])],
        ops: {
          power: (on) => call(isCover ? (on ? 'open_cover' : 'close_cover') : on ? 'turn_on' : 'turn_off'),
          toggle: () => call('toggle'),
          brightness: (v) => call('turn_on', { brightness_pct: v }),
          color: ({ r, g, b }) => call('turn_on', { rgb_color: [r, g, b] }),
          temperature: (t) => call('set_temperature', { temperature: t }),
          snapshot: async () => {
            const res = await fetch(`${base}/api/camera_proxy/${entityId}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error(`Home Assistant replied ${res.status}`);
            return { mime: res.headers.get('content-type') || 'image/jpeg', data: Buffer.from(await res.arrayBuffer()).toString('base64') };
          },
        },
      });
    }
    changed();
  }
}

// ---- public API ----
export function startHome({ bonjour, dataDir, onChange }) {
  loadSettings(dataDir);
  let timer;
  changed = () => { clearTimeout(timer); timer = setTimeout(onChange, 150); }; // coalesce bursts of updates
  for (const [name, start] of [['kasa', startKasa], ['hue', () => startHue(bonjour)], ['shelly', () => startShelly(bonjour)], ['lifx', startLifx], ['onvif', startOnvif], ['homeassistant', startHomeAssistant]]) {
    try { Promise.resolve(start()).catch(warn(name)); } catch (err) { warn(name)(err); }
  }
}

const publicOf = ({ ops, ...e }) => e;
export const homeList = () => [...entities.values()].map(publicOf).sort((a, b) => a.name.localeCompare(b.name));
export const homeAt = (ip) => homeList().filter((e) => e.ip === ip);
export const homeStatus = () => ({ homeAssistant: haStatus });

export const HOME_ACTIONS = ['turn_on', 'turn_off', 'toggle', 'set_brightness', 'set_color', 'set_temperature', 'snapshot', 'pair'];

export async function homeAction(id, action, value) {
  const e = entities.get(id);
  if (!e) throw new Error('Unknown home device');
  const need = (op) => { if (!e.ops[op]) throw new Error(`${e.name} doesn't support "${action}"`); return e.ops[op]; };
  let message;
  switch (action) {
    case 'turn_on': await need('power')(true); message = `${e.name} on`; break;
    case 'turn_off': await need('power')(false); message = `${e.name} off`; break;
    case 'toggle': await (e.ops.toggle ? e.ops.toggle() : need('power')(e.state !== 'on')); message = `${e.name} toggled`; break;
    case 'set_brightness': {
      const v = Math.max(1, Math.min(100, Math.round(Number(value))));
      if (!e.features.includes('brightness') || Number.isNaN(v)) throw new Error(`${e.name} can't set brightness to "${value}"`);
      await need('brightness')(v); message = `${e.name} at ${v}%`; break;
    }
    case 'set_color': if (!e.features.includes('color')) throw new Error(`${e.name} can't change color`); await need('color')(parseColor(value)); message = `${e.name} color set`; break;
    case 'set_temperature': {
      const t = Number(value);
      if (!e.features.includes('temperature') || Number.isNaN(t)) throw new Error(`${e.name} can't set temperature to "${value}"`);
      await need('temperature')(t); message = `${e.name} set to ${t}°`; break;
    }
    case 'snapshot': return need('snapshot')();
    case 'pair': return need('pair')();
    default: throw new Error(`Unknown action "${action}"`);
  }
  e.ops.refresh?.().catch(() => {}); // Home Assistant pushes its own updates; local drivers re-read state
  return message;
}

// The token is write-only from the UI: it is never sent back to any browser.
export function getHomeSettings() {
  const { url, token } = settings.homeAssistant ?? {};
  return { haUrl: url ?? '', haHasToken: !!token, onvifUser: settings.onvif?.username ?? '', onvifHasPassword: !!settings.onvif?.password, status: haStatus };
}

export async function saveHomeSettings({ haUrl, haToken, onvifUser, onvifPassword } = {}) {
  if (haUrl !== undefined) {
    const url = String(haUrl).trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Home Assistant URL should look like http://homeassistant.local:8123');
    settings.homeAssistant = { url, token: haToken ? String(haToken).trim() : url ? settings.homeAssistant?.token : undefined };
  }
  if (onvifUser !== undefined) settings.onvif = { username: String(onvifUser).trim(), password: onvifPassword ? String(onvifPassword) : settings.onvif?.password };
  saveSettings();
  if (haUrl !== undefined) await startHomeAssistant();
  return getHomeSettings();
}
