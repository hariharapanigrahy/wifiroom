// MCP server: lets your own AI app (Claude Desktop, Cursor, ChatGPT...) use WiFiRoom as tools.
// It talks to a running WiFiRoom over Socket.IO, starting one in-process if none is running.
// stdout carries the MCP protocol, so all logging goes to stderr.
console.log = (...a) => console.error(...a);

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { io } from 'socket.io-client';
import { z } from 'zod';

const PORT = Number(process.env.WIFIROOM_PORT) || 4321;
const URL_ = `http://127.0.0.1:${PORT}`;

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(URL_, { reconnection: false, timeout: 1500 });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => { s.close(); reject(e); });
  });
}

let socket;
try {
  socket = await connect();
} catch {
  process.env.WIFIROOM_OPEN = '0';
  await import('./server.js');
  await new Promise((r) => setTimeout(r, 1500));
  socket = await connect();
}
socket.io.opts.reconnection = true;

let devices = [];
socket.on('devices', (list) => { devices = list; });
await new Promise((r) => setTimeout(r, 1200)); // let the first device list arrive

const call = (event, payload) => new Promise((resolve) => socket.timeout(20_000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'Timed out' } : res)));
const callNoArgs = (event) => new Promise((resolve) => socket.timeout(10_000).emit(event, (err, res) => resolve(err ? [] : res)));
const nameOf = (d) => d.nickname || d.bonjourName || (d.isSelf ? 'This computer' : d.randomMac ? 'Unknown phone' : d.vendor);
const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

// Find a device by id or (part of) its name, including offline devices remembered for wake.
async function resolve(query, { includeKnown = false } = {}) {
  const q = String(query).toLowerCase();
  const pool = devices.map((d) => ({ id: d.id, name: nameOf(d), online: true }));
  if (includeKnown) for (const k of await callNoArgs('known')) if (!pool.some((p) => p.id === k.id)) pool.push({ id: k.id, name: k.name, online: false });
  const exact = pool.filter((d) => d.id === q || d.name?.toLowerCase() === q);
  const matches = exact.length ? exact : pool.filter((d) => d.name?.toLowerCase().includes(q));
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length ? `"${query}" matches several devices: ${matches.map((m) => `${m.name} (id ${m.id})`).join(', ')}. Use the id.` : `No device called "${query}". Use list_devices to see names.`);
}

const server = new McpServer({ name: 'wifiroom', version: '0.2.0' });
const tool = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema }, async (args) => {
  try { return text(await handler(args)); } catch (err) { return { ...text(`Error: ${err.message}`), isError: true }; }
});

tool('list_devices', 'List devices on the local Wi-Fi with name, status, zone and what each can do (caps: cast, dlna, wake, ring).', {}, async () =>
  devices.map((d) => ({ name: nameOf(d), id: d.id, status: d.status, zone: d.zone, ip: d.ip, maker: d.randomMac ? 'hidden (private address)' : d.vendor, joinedRoom: d.visitors > 0, caps: d.caps })));

tool('poke_device', 'Ping a device to check whether it is online and how fast it responds.', { device: z.string().describe('Device name or id') }, async ({ device }) => {
  const d = await resolve(device);
  const r = await call('poke', { to: d.id });
  return r.alive ? `${d.name} replied in ${r.ms} ms` : `${d.name} did not reply`;
});

tool('play_on_device', 'Play a link on a TV or speaker. Cast devices accept YouTube links and direct media URLs; DLNA devices accept direct media URLs only.', { device: z.string(), url: z.string().url() }, async ({ device, url }) => {
  const d = await resolve(device);
  const r = await call('action', { id: d.id, action: 'play', args: { url } });
  if (!r.ok) throw new Error(r.error);
  return `${d.name}: ${r.message}`;
});

tool('control_media', 'Control playback on a TV or speaker.', { device: z.string(), action: z.enum(['pause', 'resume', 'stop', 'volume']), level: z.number().min(0).max(100).optional().describe('Volume 0-100, for action "volume"') }, async ({ device, action, level }) => {
  const d = await resolve(device);
  const r = await call('action', { id: d.id, action, args: { level } });
  if (!r.ok) throw new Error(r.error);
  return `${d.name}: ${r.message}`;
});

tool('wake_device', 'Turn on a device (PC, NAS, some TVs) with Wake-on-LAN. Works for devices seen before, even if offline now.', { device: z.string() }, async ({ device }) => {
  const d = await resolve(device, { includeKnown: true });
  const r = await call('action', { id: d.id, action: 'wake' });
  if (!r.ok) throw new Error(r.error);
  return `${d.name}: ${r.message}`;
});

tool('ring_phone', 'Make a phone ring loudly, vibrate and flash so it can be found. Only works if that phone has the WiFiRoom page open.', { device: z.string() }, async ({ device }) => {
  const d = await resolve(device);
  const r = await call('ring', { to: d.id });
  if (!r.ok) throw new Error(r.error);
  return `Ringing ${d.name}`;
});

tool('send_link', 'Send a link that pops up on someone\'s screen in the room.', { device: z.string(), url: z.string().url() }, async ({ device, url }) => {
  const d = await resolve(device);
  const r = await call('share', { to: d.id, url });
  if (!r.ok) throw new Error(r.error);
  return r.delivered ? `Delivered to ${d.name}` : `${d.name} hasn't joined the room, so it wasn't delivered`;
});

tool('say_in_room', 'Post a chat message in the room as this computer.', { message: z.string().max(140) }, async ({ message }) => {
  socket.emit('say', message);
  return 'Sent';
});

tool('who_was_home', 'Recent arrivals and departures on the Wi-Fi, newest first.', {}, async () =>
  (await callNoArgs('timeline')).slice(0, 40).map((e) => `${new Date(e.t).toLocaleString()}: ${e.name} ${e.type}`));

await server.connect(new StdioServerTransport());
