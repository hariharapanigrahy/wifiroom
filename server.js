// WiFiRoom glue: wires discovery packages to a shared Socket.IO room. No custom discovery logic.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomInt, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { Bonjour } from 'bonjour-service';
import { getTable, toMAC } from '@network-utils/arp-lookup';
import { toVendor, isRandomMac } from '@network-utils/vendor-lookup';
import ping from 'ping';
import QRCode from 'qrcode';
import { JSONFilePreset } from 'lowdb/node';
import { startDrivers, capabilitiesOf, castName, runAction, screenTarget } from './drivers.js';
import { startHome, homeList, homeStatus, homeAction, getHomeSettings, saveHomeSettings, HOME_ACTIONS } from './home.js';
import { startChannels, idOf as uidOf } from './channels.js';
import { startProgram } from './program.js';
import { startGames } from './games.js';
import { startShares } from './shares.js';

// Set by bin/wifiroom.js. Sharing is opt-in: without --share only this laptop can open the room.
const PORT = Number(process.env.WIFIROOM_PORT) || 4321;
const SHARE = process.env.WIFIROOM_SHARE === '1';
const PASSIVE = process.env.WIFIROOM_PASSIVE === '1'; // --passive: only listen, never ping the network
const SWEEP_EVERY_MS = 15 * 60_000;
const HOST = SHARE ? '0.0.0.0' : '127.0.0.1';
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.WIFIROOM_DATA || path.join(os.homedir(), '.wifiroom');
const require = createRequire(import.meta.url);
const PHASER_DIST = path.join(path.dirname(require.resolve('phaser/package.json')), 'dist');
const NACL_DIR = path.dirname(require.resolve('tweetnacl/package.json'));
// With --code, visitors need this 6-digit code (new every start). Otherwise anyone on the Wi-Fi can walk in.
const REQUIRE_CODE = process.env.WIFIROOM_CODE === '1';
const CODE = String(randomInt(100000, 1000000));
const BUILD = String(Date.now()); // pages open from before a restart reload, so they pick up new code
const POLL_MS = 10_000;
const SLEEP_AFTER_MS = 15_000;  // missing from ARP table -> asleep
const LEAVE_AFTER_MS = 120_000; // missing this long -> walks out
const ZONES = { trusted: { x1: 1, x2: 9 }, unknown: { x1: 11, x2: 19 } }; // tile units, y is 2.5..10.5
const REACTIONS = ['👋', '❤️', '😂', '🔥', '👀', '🎉'];

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = await JSONFilePreset(path.join(DATA_DIR, 'db.json'), { labels: {}, events: [] });
db.data.events ??= [];
delete db.data.bleAngles; // left over from the Bluetooth radar, which is gone
for (const l of Object.values(db.data.labels)) delete l.bleId;
// Devices are keyed by an opaque hash so visitors never learn MAC addresses.
const idOf = (mac) => createHash('sha256').update(mac).digest('hex').slice(0, 12);
for (const key of Object.keys(db.data.labels)) if (key.includes(':')) { db.data.labels[idOf(key)] = db.data.labels[key]; delete db.data.labels[key]; }
const devices = new Map();      // id -> device
// Public keys for private chats, sent by each browser (id -> base64 X25519 key). The private halves never
// leave the browsers, so this server can only pass encrypted messages along; it can't read them.
const chatKeys = new Map();
const bonjourNames = new Map(); // ipv4 -> advertised name
let initialized = false;

const app = express();
app.use(express.static(path.join(PKG_DIR, 'public')));
app.use('/lib', express.static(PHASER_DIST));
// Answers "is a room open here?" for laptops and the phone app looking for one (see bin/wifiroom.js). A phone
// hosting an empty room hands over to a laptop's room or an older phone room, so this says which it is.
const STARTED = Date.now();
app.get('/room.json', (req, res) => res.json({
  wifiroom: true, since: STARTED, phone: process.platform === 'android',
  joined: [...io.sockets.sockets.values()].filter((s) => s.data.deviceId).length,
}));
app.get('/lib/htm-preact.js', (req, res) => res.sendFile(path.join(PKG_DIR, 'node_modules/htm/preact/standalone.module.js'))); // Preact + htm for the Program, Games and People panes
app.get('/lib/nacl-fast.min.js', (req, res) => res.sendFile(path.join(NACL_DIR, 'nacl-fast.min.js'))); // private chat encryption
const server = http.createServer(app);
const io = new Server(server);
const channelsOf = await startChannels({ dataDir: DATA_DIR, io });
const programOf = await startProgram({ dataDir: DATA_DIR, io, isHost: channelsOf.isHost, nameOf: channelsOf.nameOf });
const gamesOf = await startGames({ dataDir: DATA_DIR, io, isHost: channelsOf.isHost, nameOf: channelsOf.nameOf });
const sharesOf = startShares({ io, isHost: channelsOf.isHost, nameOf: channelsOf.nameOf });
channelsOf.onChange(() => { programOf.announce(); gamesOf.announce(); sharesOf.announce(); }); // a newly identified page gets the program and games too

// ---- discovery ----
const bonjour = new Bonjour();
for (const type of ['airplay', 'raop', 'googlecast', 'companion-link', 'hap', 'ipp', 'printer', 'smb', 'spotify-connect', 'device-info', 'sonos', 'workstation', 'http']) {
  bonjour.find({ type }, (svc) => {
    const name = svc.name.replace(/\s*\[[0-9a-f:]+\]$/i, ''); // "_workstation" names end in " [mac]"
    for (const addr of svc.addresses ?? []) if (addr.includes('.')) bonjourNames.set(addr, name);
  });
}

startDrivers({ bonjour, onChange: () => broadcast() });
// Smart-home devices are host-only: visitors never see or control them.
const homeSnapshot = () => ({ list: homeList(), ...homeStatus() });
startHome({ bonjour, dataDir: DATA_DIR, onChange: () => { io.to('host').emit('home', homeSnapshot()); broadcast(); } });

const isNoise = (r) => r.ip.endsWith('.255') || /^(22[4-9]|23\d|169\.254)\./.test(r.ip) || /^(ff:){5}ff$|^(0:){5}0$/i.test(r.mac);
const normMac = (mac) => mac.toLowerCase().split(':').map((b) => b.padStart(2, '0')).join(':');
const v4 = (addr) => addr?.replace(/^::ffff:/, '');

// On Android, mobile data (rmnet...) can be listed before Wi-Fi or the hotspot, so those come first.
const ANDROID = process.platform === 'android';
function selfIp() {
  const entries = Object.entries(os.networkInterfaces());
  if (ANDROID) entries.sort(([a], [b]) => /^(wlan|swlan|ap|softap|eth)/.test(b) - /^(wlan|swlan|ap|softap|eth)/.test(a));
  for (const [, addrs] of entries) {
    const a = addrs.find((x) => x.family === 'IPv4' && !x.internal);
    if (a) return a.address;
  }
}

// Android 10+ hides the ARP table from apps (no `arp`, no /proc/net/arp). There, devices are found by
// ping instead: addresses that answered the last sweep are pinged again on each refresh.
let arpWorks = true;
const pingSeen = new Set();
const ipMac = (ip) => `02:00:${ip.split('.').map((n) => (+n).toString(16)).join(':')}`; // stand-in id for devices known only by IP
async function arpTable() {
  try { return await getTable(); } catch {}
  try {
    return fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1).map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 4 && c[2] !== '0x0').map(([ip, , , mac]) => ({ ip, mac }));
  } catch {}
  arpWorks = false;
  return [];
}
async function pingTable() {
  const ips = [...pingSeen];
  const results = await Promise.all(ips.map((ip) => ping.promise.probe(ip, { timeout: 1 }).catch(() => ({ alive: false }))));
  return ips.filter((_, i) => results[i].alive).map((ip) => ({ ip, mac: ipMac(ip) }));
}

const label = (id) => (db.data.labels[id] ??= {});
const zoneOf = (d) => (d.isSelf ? 'trusted' : label(d.id).zone ?? (label(d.id).nickname ? 'trusted' : 'unknown'));
const randPos = (zone) => ({ x: ZONES[zone].x1 + Math.random() * (ZONES[zone].x2 - ZONES[zone].x1), y: 2.5 + Math.random() * 8 });
const clampTo = (zone, { x, y }) => ({ x: Math.min(Math.max(+x || 0, ZONES[zone].x1), ZONES[zone].x2), y: Math.min(Math.max(+y || 0, 2.5), 10.5) });
const visitorsOf = (id) => io.sockets.adapter.rooms.get(`dev:${id}`)?.size ?? 0;
const nameOf = (d) => label(d.id).nickname || d.bonjourName || (d.isSelf ? os.hostname() : d.vendor);

function logEvent(type, d) {
  db.data.events.push({ t: Date.now(), type, id: d.id, name: nameOf(d) });
  db.data.events = db.data.events.slice(-300);
  db.write();
}

// The host sees everything; visitors get only what the room needs to draw (no IPs or MACs).
function snapshot(forHost) {
  return [...devices.values()].map((d) => {
    // uid: who this device is in channels and the program (see channels.js), so People can start a chat with them.
    const full = { ...d, ...label(d.id), zone: zoneOf(d), visitors: visitorsOf(d.id), chatKey: chatRoomOf(d) ? chatKeys.get(d.id) : undefined, uid: chatKeys.has(d.id) ? uidOf(chatKeys.get(d.id)) : undefined, sharing: screenTarget() === d.ip, caps: [...capabilitiesOf(d.ip, d), ...(visitorsOf(d.id) ? ['ring'] : [])] };
    if (forHost) return full;
    const { id, pos, zone, status, isSelf, nickname, bonjourName, randomMac, vendor, visitors, chatKey, uid } = full; // no `sharing`, no home devices
    return { id, pos, zone, status, isSelf, nickname, bonjourName, randomMac, vendor, visitors, chatKey, uid, caps: visitors ? ['ring'] : [] };
  });
}
// The Socket.IO room that reaches a device's open browser tabs (the laptop's own character is the host page).
function chatRoomOf(d) {
  const room = d.isSelf ? 'host' : `dev:${d.id}`;
  return io.sockets.adapter.rooms.get(room)?.size ? room : null;
}
const broadcast = () => {
  io.to('host').emit('devices', snapshot(true));
  io.except('host').emit('devices', snapshot(false));
};

function upsert(row, now) {
  const mac = normMac(row.mac);
  const id = idOf(mac);
  const isNew = !devices.has(id);
  const d = devices.get(id) ?? { id, mac, firstSeen: now, isSelf: !!row.isSelf };
  Object.assign(d, {
    ip: row.ip,
    lastSeen: now,
    vendor: d.isSelf ? os.hostname() : toVendor(mac),
    randomMac: isRandomMac(mac),
    bonjourName: bonjourNames.get(row.ip) ?? castName(row.ip),
  });
  // Remember real hardware addresses so devices can be woken after they go offline.
  if (!d.randomMac && !d.isSelf) Object.assign(label(id), { mac, lastIp: row.ip, lastName: d.bonjourName || d.vendor });
  if (isNew) {
    d.pos = randPos(zoneOf(d));
    devices.set(id, d);
    if (initialized) { logEvent('arrived', d); io.emit('arrived', { id, unknown: zoneOf(d) === 'unknown' && !label(id).nickname }); }
  }
  return d;
}

async function refresh() {
  const now = Date.now();
  let rows = (await arpTable()).filter((r) => !isNoise(r));
  if (!arpWorks) rows = await pingTable();
  // macOS hides this machine's MAC from os.networkInterfaces(), so match ourselves by IP.
  const me = selfIp();
  for (const r of rows) r.isSelf = r.ip === me;
  if (me && !rows.some((r) => r.isSelf)) rows.push({ ip: me, mac: '02:00:00:00:00:00', isSelf: true });
  for (const r of rows) upsert(r, now);
  db.write();

  for (const d of devices.values()) {
    if (visitorsOf(d.id)) d.lastSeen = now; // an open browser tab proves it's here
    const missing = now - d.lastSeen;
    const status = missing < SLEEP_AFTER_MS ? 'here' : missing < LEAVE_AFTER_MS ? 'asleep' : 'gone';
    if (initialized && status !== d.status && status !== 'here') logEvent(status === 'gone' ? 'left' : 'fell asleep', d);
    d.status = status;
  }
  broadcast();
  for (const [id, d] of devices) if (d.status === 'gone') devices.delete(id);
  initialized = true;
}

// ---- shared device commands (used by the room's sockets and the local HTTP API) ----
const selfDevice = () => [...devices.values()].find((d) => d.isSelf);

// Devices seen before with a real hardware address, including ones that are offline now (for wake).
const knownDevices = () => Object.entries(db.data.labels).filter(([, l]) => l.mac).map(([id, l]) => ({ id, name: l.nickname || l.lastName, mac: l.mac, online: devices.has(id) }));

// Find an item by id or (part of) its name. Throws a helpful error when nothing or several match.
function pickByName(pool, query) {
  const q = String(query).toLowerCase();
  const exact = pool.filter((d) => d.id === q || d.name?.toLowerCase() === q);
  const matches = exact.length ? exact : pool.filter((d) => d.name?.toLowerCase().includes(q));
  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
  throw new Error(matches.length ? `"${query}" matches several devices: ${matches.map((m) => `${m.name} (id ${m.id})`).join(', ')}. Use the id.` : `No device called "${query}"`);
}

// `includeKnown` adds offline devices remembered for wake.
function resolveDevice(query, { includeKnown = false } = {}) {
  const pool = [...devices.values()].map((d) => ({ id: d.id, name: nameOf(d) }));
  if (includeKnown) for (const k of knownDevices()) if (!devices.has(k.id)) pool.push({ id: k.id, name: k.name });
  return pickByName(pool, query);
}

async function pokeDevice(from, to) {
  const target = devices.get(to);
  if (!target) throw new Error('Unknown device');
  io.to(`dev:${to}`).emit('poked-you', { from: nameOf(from) });
  const res = await ping.promise.probe(target.ip, { timeout: 2 });
  const result = { from: from.id, to, alive: res.alive, ms: res.alive ? Math.round(Number(res.time)) : null };
  io.emit('poked', result);
  return result;
}

// Offline devices can be woken by id.
async function controlDevice(id, action, args) {
  const d = devices.get(id) ?? (db.data.labels[id]?.mac ? { id, ip: db.data.labels[id].lastIp, mac: db.data.labels[id].mac } : null);
  if (!d) throw new Error('Unknown device');
  const message = await runAction(d, action, args);
  if (devices.has(id)) io.emit('bubble', { id, text: `🎛️ ${message}` });
  return message;
}

// Ring a phone that has the room open: loud sound, vibration and a flashing screen.
function ringDevice(from, to) {
  if (!devices.has(to)) throw new Error('Unknown device');
  if (!visitorsOf(to)) throw new Error("That device hasn't joined the room");
  io.to(`dev:${to}`).emit('ring', { from: nameOf(from) });
}

const isChatKey = (k) => typeof k === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(k); // 32 bytes, base64
const isHostAddr = (addr) => ['127.0.0.1', '::1', selfIp()].includes(v4(addr));

// ---- local HTTP API (for scripts and the `wifiroom <command>` CLI) ----
// Only this computer may call it, even with --share. The Host and Origin checks stop web pages open
// in your browser from calling it (DNS rebinding and cross-site requests).
const api = express.Router();
const localHosts = () => ['localhost', '127.0.0.1', '[::1]', selfIp()].map((h) => `${h}:${PORT}`);
api.use((req, res, next) => {
  const local = isHostAddr(req.socket.remoteAddress) && localHosts().includes(req.headers.host);
  const origin = req.headers.origin;
  if (!local || (origin && !localHosts().some((h) => origin === `http://${h}`))) return res.status(403).json({ ok: false, error: 'The API only accepts requests from this computer' });
  next();
});
api.use(express.json());

const deviceView = (d) => {
  const { id, ip, mac, randomMac, vendor, status, zone, nickname, bonjourName, caps, visitors, isSelf } = d;
  return { id, name: nameOf(d), status, zone, ip, mac: randomMac ? null : mac, maker: randomMac ? null : vendor, privateAddress: randomMac, nickname: nickname || null, bonjourName: bonjourName || null, isSelf, joinedRoom: visitors > 0, caps };
};
const DEVICE_ACTIONS = ['play', 'pause', 'resume', 'stop', 'volume', 'wake', 'screen_start', 'screen_stop'];

api.get('/devices', (req, res) => res.json(snapshot(true).map(deviceView)));
api.get('/known', (req, res) => res.json(knownDevices()));
api.get('/timeline', (req, res) => res.json(db.data.events.slice(-100).reverse()));
api.get('/home', (req, res) => res.json(homeList()));

api.post('/scan', async (req, res) => {
  const pinged = await sweep();
  res.json({ ok: true, pinged, devices: snapshot(true).map(deviceView) });
});

// POST /api/devices/<name or id>/<action>, e.g. /api/devices/living%20room/play with {"url": "..."}
api.post('/devices/:device/:action', async (req, res) => {
  const { action } = req.params, body = req.body ?? {};
  try {
    const d = resolveDevice(req.params.device, { includeKnown: action === 'wake' });
    if (action === 'poke') {
      const r = await pokeDevice(selfDevice() ?? { id: null }, d.id);
      return res.json({ ok: true, device: d, alive: r.alive, ms: r.ms });
    }
    if (action === 'ring') {
      ringDevice(selfDevice() ?? { id: null }, d.id);
      return res.json({ ok: true, device: d, message: 'Ringing' });
    }
    if (!DEVICE_ACTIONS.includes(action)) return res.status(404).json({ ok: false, error: `Unknown action "${action}"` });
    if (action === 'play' && !body.url) return res.status(400).json({ ok: false, error: 'Missing "url"' });
    const level = typeof body.level === 'number' || (typeof body.level === 'string' && body.level.trim()) ? Number(body.level) : NaN;
    if (action === 'volume' && !(level >= 0 && level <= 100)) return res.status(400).json({ ok: false, error: '"level" must be 0-100' });
    res.json({ ok: true, device: d, message: await controlDevice(d.id, action, body) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/home/<name or id>/<action> with optional {"value": ...}: turn_on, turn_off, toggle,
// set_brightness, set_color, set_temperature, snapshot.
api.post('/home/:device/:action', async (req, res) => {
  const { action } = req.params;
  try {
    if (!HOME_ACTIONS.includes(action) || action === 'pair') return res.status(404).json({ ok: false, error: `Unknown action "${action}"` });
    const e = pickByName(homeList(), req.params.device);
    const result = await homeAction(e.id, action, req.body?.value);
    res.json(typeof result === 'string' ? { ok: true, device: e, message: result } : { ok: true, device: e, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
api.use((req, res) => res.status(404).json({ ok: false, error: `No such API route: ${req.method} ${req.path}` }));
api.use((err, req, res, next) => res.status(err.status ?? 500).json({ ok: false, error: err.type === 'entity.parse.failed' ? 'Body is not valid JSON' : err.message }));
app.use('/api', api);

// ---- sockets ----

io.use((socket, next) => {
  socket.data.host = isHostAddr(socket.handshake.address);
  if (socket.data.host || !REQUIRE_CODE || socket.handshake.auth?.code === CODE) return next();
  next(new Error('bad-code'));
});

io.on('connection', async (socket) => {
  const host = socket.data.host;
  if (host) socket.join('host');
  channelsOf.attach(socket, { isHost: host });
  programOf.attach(socket);
  gamesOf.attach(socket);
  sharesOf.attach(socket);
  // Anyone in the room can invite others: the address and QR go to everyone (people who joined already know the code).
  const joinUrl = joinUrlOf();
  socket.emit('hello', {
    host, build: BUILD, platform: process.platform, reactions: REACTIONS, lanShared: HOST !== '127.0.0.1',
    joinUrl: SHARE ? joinUrl : null, qr: SHARE ? await QRCode.toDataURL(joinUrl, { margin: 1, width: 240 }) : null,
    ...(host && { code: REQUIRE_CODE ? CODE : null }),
  });
  socket.emit('devices', snapshot(host));
  if (host) {
    socket.emit('home', homeSnapshot());
  }

  // Simple per-socket throttle so one visitor can't flood the room.
  const last = {};
  const allow = (key, ms) => { const now = Date.now(); if (now - (last[key] ?? 0) < ms) return false; last[key] = now; return true; };

  // Who is acting: the host acts as this laptop; a visitor acts as the device their browser runs on.
  const actor = () => (host ? selfDevice() : devices.get(socket.data.deviceId));

  socket.on('join', async ({ name, chatKey } = {}) => {
    if (host || !allow('join', 2000)) return;
    const gate = channelsOf.admits(chatKey);
    if (!gate.ok) return socket.emit('join-refused', { error: gate.error });
    const ip = v4(socket.handshake.address);
    let d = [...devices.values()].find((x) => x.ip === ip);
    if (!d) {
      const mac = arpWorks ? await toMAC(ip).catch(() => null) : null;
      d = upsert({ ip, mac: mac ?? ipMac(ip) }, Date.now());
    }
    socket.data.deviceId = d.id;
    socket.join(`dev:${d.id}`);
    const clean = String(name ?? '').trim().slice(0, 40);
    if (clean) label(d.id).nickname = clean;
    if (isChatKey(chatKey)) chatKeys.set(d.id, chatKey);
    logEvent('joined the room', d);
    socket.emit('you', { id: d.id });
    io.emit('bubble', { id: d.id, text: '👋 joined the room!' });
    broadcast();
  });

  socket.on('disconnect', () => { if (host || socket.data.deviceId) broadcast(); }); // their chat key stops being offered

  socket.on('move', ({ x, y } = {}) => {
    const d = actor();
    if (!d || !allow('move', 100)) return;
    d.pos = clampTo(zoneOf(d), { x, y });
    d.placed = true;
    broadcast();
  });

  socket.on('say', (text) => {
    const d = actor();
    const clean = String(text ?? '').trim().slice(0, 140);
    if (d && clean && allow('say', 1000)) io.emit('bubble', { id: d.id, text: clean });
  });

  // ---- private and group chats (end-to-end encrypted) ----
  // The host page has no join step, so it registers its key here.
  socket.on('chat-key', (chatKey) => {
    const d = actor();
    if (!host || !d || !isChatKey(chatKey)) return;
    chatKeys.set(d.id, chatKey);
    broadcast();
  });

  // Each browser encrypts a message once per recipient with nacl.box. This only checks sizes and passes
  // each recipient its own ciphertext; nothing is stored or logged.
  socket.on('dm', ({ boxes } = {}, ack) => {
    const d = actor();
    if (!d || !chatKeys.has(d.id)) return ack?.({ ok: false, error: 'Join the room first' });
    if (!allow('dm', 250)) return ack?.({ ok: false, error: 'Slow down a little' });
    const list = Array.isArray(boxes) ? boxes.slice(0, 12) : [];
    const missed = [];
    for (const b of list) {
      const target = devices.get(b?.to);
      if (typeof b?.nonce !== 'string' || typeof b?.box !== 'string' || b.nonce.length > 40 || b.box.length > 8000) continue;
      const room = target && chatRoomOf(target);
      if (!room || target.id === d.id) { missed.push(b?.to); continue; }
      io.to(room).emit('dm', { from: d.id, to: target.id, nonce: b.nonce, box: b.box });
    }
    ack?.({ ok: true, missed });
  });

  // Calls and file transfers connect browsers directly (WebRTC). This passes their connection setup along,
  // sealed with the same keys as chats, so the room can't read it or put itself in the middle.
  // Browsers send their connection candidates in a burst, so this is capped per second rather than spaced out.
  let signals = { at: 0, n: 0 };
  socket.on('signal', ({ to, nonce, box } = {}) => {
    const d = actor(), target = devices.get(to);
    const now = Date.now();
    if (now - signals.at > 1000) signals = { at: now, n: 0 };
    if (!d || !target || target.id === d.id || typeof nonce !== 'string' || typeof box !== 'string' || box.length > 20000 || ++signals.n > 200) return;
    const room = chatRoomOf(target);
    if (room) io.to(room).emit('signal', { from: d.id, nonce, box });
  });

  // When two devices can't reach each other directly, file chunks come through here instead, encrypted with
  // a key only the chat members have. Nothing is kept; the ack paces the sender.
  socket.on('relay', ({ to, file, seq, chunk } = {}, ack) => {
    const d = actor(), target = devices.get(to);
    const room = target && target.id !== d?.id && chatRoomOf(target);
    if (!d || !room || typeof file !== 'string' || file.length > 40 || !Number.isInteger(seq) || !(chunk instanceof Buffer) || chunk.length > 70_000) return ack?.({ ok: false });
    io.to(room).emit('relay', { from: d.id, file, seq, chunk });
    ack?.({ ok: true });
  });

  socket.on('react', ({ to, emoji } = {}) => {
    const d = actor();
    if (d && devices.has(to) && REACTIONS.includes(emoji) && allow('react', 300)) io.emit('react', { from: d.id, to, emoji });
  });

  socket.on('poke', async ({ to } = {}, ack) => {
    const d = actor();
    if (!d || !devices.has(to) || !allow('poke', 2000)) return;
    ack?.(await pokeDevice(d, to));
  });

  socket.on('share', ({ to, url } = {}, ack) => {
    const d = actor(), target = devices.get(to);
    let link;
    try { link = new URL(String(url)); } catch { return ack?.({ ok: false, error: 'Not a valid link' }); }
    if (!/^https?:$/.test(link.protocol)) return ack?.({ ok: false, error: 'Only http(s) links can be sent' });
    if (!d) return ack?.({ ok: false, error: 'Join the room first' });
    if (!target) return ack?.({ ok: false, error: 'That device left the room' });
    if (!allow('share', 2000)) return ack?.({ ok: false, error: 'Slow down a little' });
    const room = target.isSelf ? 'host' : `dev:${to}`;
    const delivered = (io.sockets.adapter.rooms.get(room)?.size ?? 0) > 0;
    io.to(room).emit('card', { from: nameOf(d), fromId: d.id, to, url: link.href });
    io.emit('shared', { from: d.id, to });
    ack?.({ ok: true, delivered });
  });

  // ---- host-only controls ----
  socket.on('label', async ({ id, nickname, zone } = {}) => {
    if (!host || !devices.has(id)) return;
    const l = label(id), d = devices.get(id);
    const before = zoneOf(d);
    if (nickname !== undefined) l.nickname = String(nickname).trim().slice(0, 40);
    if (zone === 'trusted' || zone === 'unknown') l.zone = zone;
    if (zoneOf(d) !== before) d.pos = randPos(zoneOf(d));
    await db.write();
    broadcast();
  });

  socket.on('place', async ({ id, x, y } = {}) => {
    const d = devices.get(id);
    if (!host || !d) return;
    if (!d.isSelf) label(id).zone = x < 10 ? 'trusted' : 'unknown';
    d.pos = clampTo(zoneOf(d), { x, y });
    d.placed = true;
    await db.write();
    broadcast();
  });

  socket.on('timeline', (ack) => host && ack?.(db.data.events.slice(-100).reverse()));

  // Ping every address on the subnet once so quiet devices show up (host only).
  socket.on('scan', async (...args) => {
    const ack = args.find((a) => typeof a === 'function'); // called with or without a payload
    if (!host) return ack?.({ ok: false });
    const found = await sweep();
    ack?.({ ok: true, devices: devices.size, pinged: found });
  });

  // Device control (host only): play a link, volume, pause/resume/stop, screen, wake.
  socket.on('action', async ({ id, action, args } = {}, ack) => {
    if (!host || !allow('action', 500)) return ack?.({ ok: false, error: 'Not allowed' });
    try {
      ack?.({ ok: true, message: await controlDevice(id, action, args) });
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });

  // Smart-home devices and Home Assistant entities (host only).
  socket.on('home-list', (ack) => host && ack?.(homeSnapshot()));
  socket.on('home-action', async ({ id, action, value } = {}, ack) => {
    if (!host) return ack?.({ ok: false, error: 'Not allowed' }); // no throttle: voice assistants send commands back to back
    try {
      const result = await homeAction(String(id), String(action), value);
      ack?.(typeof result === 'string' ? { ok: true, message: result } : { ok: true, ...result });
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });
  // The Home Assistant token is accepted here but never sent back to a browser.
  socket.on('home-settings', (ack) => host && ack?.(getHomeSettings()));
  socket.on('home-settings-save', async (values = {}, ack) => {
    if (!host) return ack?.({ ok: false, error: 'Not allowed' });
    try { ack?.({ ok: true, ...(await saveHomeSettings(values)) }); } catch (err) { ack?.({ ok: false, error: err.message }); }
  });

  socket.on('known', (ack) => host && ack?.(knownDevices()));

  socket.on('ring', ({ to } = {}, ack) => {
    const d = actor();
    if (!d || !allow('ring', 5000)) return ack?.({ ok: false, error: "Can't ring right now" });
    try {
      ringDevice(d, to);
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });
});

// macOS lets a "this laptop only" server and a "whole network" server share a port, which splits
// the room in two. Refuse to start if anything already answers on this port locally.
const busy = await new Promise((resolve) => {
  const probe = net.connect({ host: '127.0.0.1', port: PORT }, () => { probe.destroy(); resolve(true); });
  probe.on('error', () => resolve(false));
  probe.setTimeout(800, () => { probe.destroy(); resolve(false); });
});
if (busy) {
  console.error(`WiFiRoom (or something else) is already running on port ${PORT}. Stop it first, or use --port ${PORT + 1}.`);
  process.exit(1);
}

const joinUrlOf = () => `http://${selfIp()}:${PORT}/${REQUIRE_CODE ? `?code=${CODE}` : ''}`;

// Easy addresses for phones: http://wifiroom.local and plain http://<this computer's IP> (port 80) both
// redirect into the room. Best-effort: skipped quietly if port 80 is taken or not allowed.
function startShortUrl() {
  bonjour.publish({ name: 'WiFiRoom', type: 'http', port: PORT, host: 'wifiroom.local' });
  // Lets another laptop or the phone app join this room instead of opening a second one. The address goes
  // in TXT because Android names itself "localhost", and is announced again when the Wi-Fi address changes.
  // Never the code: anyone on the Wi-Fi can read this.
  let announced = null;
  const announce = () => {
    const url = `http://${selfIp()}:${PORT}/`;
    if (announced?.url === url) return;
    announced?.service.stop();
    announced = { url, service: bonjour.publish({ name: `WiFiRoom ${randomInt(1e9)}`, type: 'wifiroom', port: PORT, txt: { url } }) };
  };
  announce();
  setInterval(announce, 30_000);
  const redirect = http.createServer((req, res) => { res.writeHead(302, { location: joinUrlOf() }); res.end(); });
  redirect.on('error', () => {});
  redirect.listen(80, HOST, () => console.log(`     Short address: http://${selfIp()} (iPhones and laptops can also use http://wifiroom.local; most Android phones can't)`));
}

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Try: npx wifiroom --port ${PORT + 1}` : err.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`\n  🏠 WiFiRoom is running at http://localhost:${PORT}`);
  if (SHARE) {
    console.log(`  📲 Sharing on your Wi-Fi: ${joinUrlOf()}`);
    console.log(REQUIRE_CODE ? '     Anyone on this network with the code can join. Use only on networks you trust.'
      : '     Anyone on this Wi-Fi can join, no code needed (add --code to require one). Device controls stay on this computer.');
    startShortUrl();
  } else {
    console.log('  🔒 Only this computer can open it. Add --share to let phones on your Wi-Fi join.');
  }
  console.log(`  💾 Your labels are saved in ${DATA_DIR}\n`);
  if (process.env.WIFIROOM_OPEN === '1') import('open').then(({ default: open }) => open(`http://localhost:${PORT}`)).catch(() => {});
});
// Reading the ARP table only shows devices this computer recently talked to. A gentle sweep (one ping per
// address, in small batches) fills it in so quiet devices like TVs and speakers appear too.
let sweeping = null;
function sweep() {
  sweeping ??= (async () => {
    const me = selfIp();
    if (!me) return 0;
    const base = me.split('.').slice(0, 3).join('.');
    const ips = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`).filter((ip) => ip !== me);
    let alive = 0;
    io.emit('scan', 'started');
    for (let i = 0; i < ips.length; i += 32) {
      const batch = ips.slice(i, i + 32);
      const results = await Promise.all(batch.map((ip) => ping.promise.probe(ip, { timeout: 1 }).catch(() => ({ alive: false }))));
      batch.forEach((ip, j) => results[j].alive && pingSeen.add(ip));
      alive += results.filter((r) => r.alive).length;
    }
    await refresh();
    io.emit('scan', 'done');
    return alive;
  })().finally(() => { sweeping = null; });
  return sweeping;
}

// Idle wandering, decided here so every viewer sees the same room. Awake characters take a few steps
// within their zone now and then; sleeping ones, people who joined (they steer) and anyone placed by hand stay put.
setInterval(() => {
  let moved = false;
  for (const d of devices.values()) {
    if (d.status !== 'here' || d.placed || visitorsOf(d.id) || Math.random() > 0.3) continue;
    const step = () => (Math.random() - 0.5) * 3; // up to 1.5 tiles each way
    d.pos = clampTo(zoneOf(d), { x: d.pos.x + step(), y: d.pos.y + step() });
    moved = true;
  }
  if (moved) broadcast();
}, 3000);

refresh();
setInterval(refresh, POLL_MS);
if (!PASSIVE) { sweep(); setInterval(sweep, SWEEP_EVERY_MS); }
