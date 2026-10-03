// WiFiRoom glue: wires discovery packages to a shared Socket.IO room. No custom discovery logic.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fork } from 'node:child_process';
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
import { startDrivers, capabilitiesOf, castName, runAction } from './drivers.js';

// Set by bin/wifiroom.js. Sharing is opt-in: without --share only this laptop can open the room.
const PORT = Number(process.env.WIFIROOM_PORT) || 4321;
const SHARE = process.env.WIFIROOM_SHARE === '1';
const HOST = SHARE ? '0.0.0.0' : '127.0.0.1';
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.WIFIROOM_DATA || path.join(os.homedir(), '.wifiroom');
const PHASER_DIST = path.join(path.dirname(createRequire(import.meta.url).resolve('phaser/package.json')), 'dist');
const CODE = String(randomInt(100000, 1000000)); // visitors need this; new every start
const POLL_MS = 10_000;
const SLEEP_AFTER_MS = 15_000;  // missing from ARP table -> asleep
const LEAVE_AFTER_MS = 120_000; // missing this long -> walks out
const ZONES = { trusted: { x1: 1, x2: 9 }, unknown: { x1: 11, x2: 19 } }; // tile units, y is 2.5..10.5
const REACTIONS = ['👋', '❤️', '😂', '🔥', '👀', '🎉'];

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = await JSONFilePreset(path.join(DATA_DIR, 'db.json'), { labels: {}, events: [] });
db.data.events ??= [];
// Devices are keyed by an opaque hash so visitors never learn MAC addresses.
const idOf = (mac) => createHash('sha256').update(mac).digest('hex').slice(0, 12);
for (const key of Object.keys(db.data.labels)) if (key.includes(':')) { db.data.labels[idOf(key)] = db.data.labels[key]; delete db.data.labels[key]; }
const devices = new Map();      // id -> device
const bonjourNames = new Map(); // ipv4 -> advertised name
let ble = { status: 'starting', list: [] };
let initialized = false;

const app = express();
app.use(express.static(path.join(PKG_DIR, 'public')));
app.use('/lib', express.static(PHASER_DIST));
const server = http.createServer(app);
const io = new Server(server);

// ---- discovery ----
const bonjour = new Bonjour();
for (const type of ['airplay', 'raop', 'googlecast', 'companion-link', 'hap', 'ipp', 'printer', 'smb', 'spotify-connect', 'device-info', 'sonos', 'workstation', 'http']) {
  bonjour.find({ type }, (svc) => {
    const name = svc.name.replace(/\s*\[[0-9a-f:]+\]$/i, ''); // "_workstation" names end in " [mac]"
    for (const addr of svc.addresses ?? []) if (addr.includes('.')) bonjourNames.set(addr, name);
  });
}

startDrivers({ bonjour, onChange: () => broadcast() });

const isNoise = (r) => r.ip.endsWith('.255') || /^(22[4-9]|23\d|169\.254)\./.test(r.ip) || /^(ff:){5}ff$|^(0:){5}0$/i.test(r.mac);
const normMac = (mac) => mac.toLowerCase().split(':').map((b) => b.padStart(2, '0')).join(':');
const v4 = (addr) => addr?.replace(/^::ffff:/, '');

function selfIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    const a = addrs.find((x) => x.family === 'IPv4' && !x.internal);
    if (a) return a.address;
  }
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

// The host sees everything; visitors get only what the room needs to draw (no IPs, MACs, Bluetooth).
function snapshot(forHost) {
  return [...devices.values()].map((d) => {
    const full = { ...d, ...label(d.id), zone: zoneOf(d), visitors: visitorsOf(d.id), caps: [...capabilitiesOf(d.ip, d), ...(visitorsOf(d.id) ? ['ring'] : [])] };
    if (forHost) return full;
    const { id, pos, zone, status, isSelf, nickname, bonjourName, randomMac, vendor, visitors } = full;
    return { id, pos, zone, status, isSelf, nickname, bonjourName, randomMac, vendor, visitors, caps: visitors ? ['ring'] : [] };
  });
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
  const rows = (await getTable()).filter((r) => !isNoise(r));
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

// ---- Bluetooth worker (optional) ----
function startBle() {
  const child = fork(new URL('./ble.js', import.meta.url), { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', (m) => {
    if (m.type === 'state') ble.status = m.state;
    if (m.type === 'devices') ble.list = m.list;
    io.to('host').emit('ble', ble);
  });
  child.on('exit', (code, signal) => {
    // macOS kills processes that use Bluetooth without permission (SIGABRT / 134).
    ble = { status: signal === 'SIGABRT' || code === 134 ? 'needs-permission' : 'unavailable', list: [] };
    io.to('host').emit('ble', ble);
  });
}

// ---- sockets ----
const isHostAddr = (addr) => ['127.0.0.1', '::1', selfIp()].includes(v4(addr));

io.use((socket, next) => {
  socket.data.host = isHostAddr(socket.handshake.address);
  if (socket.data.host || socket.handshake.auth?.code === CODE) return next();
  next(new Error('bad-code'));
});

io.on('connection', async (socket) => {
  const host = socket.data.host;
  if (host) socket.join('host');
  const joinUrl = `http://${selfIp()}:${PORT}/?code=${CODE}`;
  socket.emit('hello', {
    host, platform: process.platform, reactions: REACTIONS, lanShared: HOST !== '127.0.0.1',
    ...(host && { code: CODE, joinUrl, qr: await QRCode.toDataURL(joinUrl, { margin: 1, width: 240 }) }),
  });
  socket.emit('devices', snapshot(host));
  if (host) {
    socket.emit('ble', ble);
    socket.emit('ble-angles', db.data.bleAngles ?? {});
  }

  // Simple per-socket throttle so one visitor can't flood the room.
  const last = {};
  const allow = (key, ms) => { const now = Date.now(); if (now - (last[key] ?? 0) < ms) return false; last[key] = now; return true; };

  // Who is acting: the host acts as this laptop; a visitor acts as the device their browser runs on.
  const actor = () => (host ? [...devices.values()].find((d) => d.isSelf) : devices.get(socket.data.deviceId));

  socket.on('join', async ({ name } = {}) => {
    if (host || !allow('join', 2000)) return;
    const ip = v4(socket.handshake.address);
    let d = [...devices.values()].find((x) => x.ip === ip);
    if (!d) {
      const mac = await toMAC(ip);
      d = upsert({ ip, mac: mac ?? `00:00:${ip.split('.').map((n) => (+n).toString(16)).join(':')}` }, Date.now());
    }
    socket.data.deviceId = d.id;
    socket.join(`dev:${d.id}`);
    const clean = String(name ?? '').trim().slice(0, 40);
    if (clean) label(d.id).nickname = clean;
    logEvent('joined the room', d);
    socket.emit('you', { id: d.id });
    io.emit('bubble', { id: d.id, text: '👋 joined the room!' });
    broadcast();
  });

  socket.on('disconnect', () => { if (socket.data.deviceId) broadcast(); });

  socket.on('move', ({ x, y } = {}) => {
    const d = actor();
    if (!d || !allow('move', 100)) return;
    d.pos = clampTo(zoneOf(d), { x, y });
    broadcast();
  });

  socket.on('say', (text) => {
    const d = actor();
    const clean = String(text ?? '').trim().slice(0, 140);
    if (d && clean && allow('say', 1000)) io.emit('bubble', { id: d.id, text: clean });
  });

  socket.on('react', ({ to, emoji } = {}) => {
    const d = actor();
    if (d && devices.has(to) && REACTIONS.includes(emoji) && allow('react', 300)) io.emit('react', { from: d.id, to, emoji });
  });

  socket.on('poke', async ({ to } = {}, ack) => {
    const d = actor(), target = devices.get(to);
    if (!d || !target || !allow('poke', 2000)) return;
    io.to(`dev:${to}`).emit('poked-you', { from: nameOf(d) });
    const res = await ping.promise.probe(target.ip, { timeout: 2 });
    const result = { from: d.id, to, alive: res.alive, ms: res.alive ? Math.round(Number(res.time)) : null };
    io.emit('poked', result);
    ack?.(result);
  });

  socket.on('share', ({ to, url } = {}, ack) => {
    const d = actor(), target = devices.get(to);
    let link;
    try { link = new URL(String(url)); } catch { return ack?.({ ok: false, error: 'Not a valid link' }); }
    if (!d || !target || !/^https?:$/.test(link.protocol)) return ack?.({ ok: false, error: 'Not a valid link' });
    if (!allow('share', 2000)) return ack?.({ ok: false, error: 'Slow down a little' });
    const room = target.isSelf ? 'host' : `dev:${to}`;
    const delivered = (io.sockets.adapter.rooms.get(room)?.size ?? 0) > 0;
    io.to(room).emit('card', { from: nameOf(d), fromId: d.id, to, url: link.href });
    io.emit('shared', { from: d.id, to });
    ack?.({ ok: true, delivered });
  });

  // ---- host-only controls ----
  socket.on('label', async ({ id, nickname, zone, bleId } = {}) => {
    if (!host || !devices.has(id)) return;
    const l = label(id), d = devices.get(id);
    const before = zoneOf(d);
    if (nickname !== undefined) l.nickname = String(nickname).trim().slice(0, 40);
    if (zone === 'trusted' || zone === 'unknown') l.zone = zone;
    if (bleId !== undefined) l.bleId = bleId || null;
    if (zoneOf(d) !== before) d.pos = randPos(zoneOf(d));
    await db.write();
    broadcast();
  });

  socket.on('place', async ({ id, x, y } = {}) => {
    const d = devices.get(id);
    if (!host || !d) return;
    if (!d.isSelf) label(id).zone = x < 10 ? 'trusted' : 'unknown';
    d.pos = clampTo(zoneOf(d), { x, y });
    await db.write();
    broadcast();
  });

  socket.on('ble-angle', async ({ bleId, angle } = {}) => {
    if (!host || typeof bleId !== 'string') return;
    (db.data.bleAngles ??= {})[bleId] = Number(angle) || 0;
    await db.write();
    io.to('host').emit('ble-angles', db.data.bleAngles);
  });

  socket.on('timeline', (ack) => host && ack?.(db.data.events.slice(-100).reverse()));

  // Device control (host only): play a link, volume, pause/resume/stop, wake. Offline devices can be woken by id.
  socket.on('action', async ({ id, action, args } = {}, ack) => {
    if (!host || !allow('action', 500)) return ack?.({ ok: false, error: 'Not allowed' });
    const d = devices.get(id) ?? (db.data.labels[id]?.mac ? { id, ip: db.data.labels[id].lastIp, mac: db.data.labels[id].mac } : null);
    if (!d) return ack?.({ ok: false, error: 'Unknown device' });
    try {
      const message = await runAction(d, action, args);
      if (devices.has(id)) io.emit('bubble', { id, text: `🎛️ ${message}` });
      ack?.({ ok: true, message });
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });

  // Devices seen before with a real hardware address, including ones that are offline now (for wake).
  socket.on('known', (ack) => host && ack?.(Object.entries(db.data.labels).filter(([, l]) => l.mac).map(([id, l]) => ({ id, name: l.nickname || l.lastName, mac: l.mac, online: devices.has(id) }))));

  // Ring a phone that has the room open: loud sound, vibration and a flashing screen.
  socket.on('ring', ({ to } = {}, ack) => {
    const d = actor(), target = devices.get(to);
    if (!d || !target || !allow('ring', 5000)) return ack?.({ ok: false, error: "Can't ring right now" });
    const delivered = visitorsOf(to) > 0;
    io.to(`dev:${to}`).emit('ring', { from: nameOf(d) });
    ack?.({ ok: delivered, error: delivered ? undefined : "That device hasn't joined the room" });
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

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Try: npx wifiroom --port ${PORT + 1}` : err.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`\n  🏠 WiFiRoom is running at http://localhost:${PORT}`);
  if (SHARE) {
    console.log(`  📲 Sharing on your Wi-Fi: http://${selfIp()}:${PORT}/?code=${CODE}`);
    console.log('     Anyone on this network with the code can join. Use only on networks you trust.');
  } else {
    console.log('  🔒 Only this computer can open it. Add --share to let phones on your Wi-Fi join.');
  }
  console.log(`  💾 Your labels are saved in ${DATA_DIR}\n`);
  if (process.env.WIFIROOM_OPEN === '1') import('open').then(({ default: open }) => open(`http://localhost:${PORT}`)).catch(() => {});
});
refresh();
setInterval(refresh, POLL_MS);
startBle();
