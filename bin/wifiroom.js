#!/usr/bin/env node
// Command-line entry: `npx wifiroom [command] [--share] [--port 4321] [--no-open]`
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    share: { type: 'boolean', default: false },
    host: { type: 'boolean', default: false },
    code: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.WIFIROOM_PORT || '4321' },
    'no-open': { type: 'boolean', default: false },
    passive: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`
  WiFiRoom: see who's on your Wi-Fi, as characters in a tiny pixel room.

  Usage: npx wifiroom [options]          Open the room in your browser
         npx wifiroom serve              Run in the background, without opening a browser
         npx wifiroom mcp                Run as an MCP server for Claude Desktop, Cursor, etc.

  Commands (need WiFiRoom running):
         wifiroom devices                List devices and what each can do
         wifiroom history                Recent arrivals and departures
         wifiroom scan                   Ping the network once to find quiet devices
         wifiroom poke <device>          Ping a device
         wifiroom play <device> <url>    Play a YouTube link or media URL on a TV or speaker
         wifiroom pause|resume|stop <device>
         wifiroom volume <device> <0-100>
         wifiroom screen <device> start|stop   Show this computer's screen on a TV
         wifiroom wake <device>          Wake-on-LAN, works for offline devices seen before
         wifiroom ring <device>          Ring a phone that has the room open
         wifiroom home                   List smart-home devices
         wifiroom home <device> on|off|toggle|brightness|color|temp|snapshot [value]

    <device> is a name, part of a name, or an id from \`wifiroom devices\` or \`wifiroom home\`.

    --share       Let anyone on your Wi-Fi join the room at this computer's IP
    --host        Open your own room even if someone on this Wi-Fi already has one open
    --code        With --share, also require a 6-digit code to join
    --port <n>    Port to use (default 4321)
    --no-open     Don't open the browser automatically
    --passive     Only listen; don't ping the network to find quiet devices
    --json        Print command results as JSON
    -h, --help    Show this help
`);
  process.exit(0);
}

process.env.WIFIROOM_PORT = values.port;
const [command, ...args] = positionals;

const { COMMANDS, runCli } = await import('../cli.js');
if (COMMANDS.includes(command)) {
  await runCli(command, args, { json: values.json });
} else if (command && !['serve', 'mcp'].includes(command)) {
  console.error(`wifiroom: unknown command "${command}". See: npx wifiroom --help`);
  process.exit(1);
} else if (!command && !values.host && await joinOpenRoom()) {
  // Joined someone else's room; this process stays up as the local proxy (see joinOpenRoom).
} else {
  process.env.WIFIROOM_SHARE = values.share ? '1' : '0';
  process.env.WIFIROOM_CODE = values.code ? '1' : '0';
  process.env.WIFIROOM_OPEN = values['no-open'] || command === 'serve' ? '0' : '1';
  process.env.WIFIROOM_PASSIVE = values.passive ? '1' : '0';
  await import(command === 'mcp' ? '../mcp.js' : '../server.js');
}

// One room per Wi-Fi: if a shared room (another laptop, or the phone app) is already open and answers,
// open it in the browser instead of starting a second one. Gives up after 4 seconds.
async function joinOpenRoom() {
  const { Bonjour } = await import('bonjour-service');
  const bonjour = new Bonjour();
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    // Many routers drop the multicast Bonjour rides on, so also ask every address on the Wi-Fi directly.
    scanForRoom().then((found) => { if (found) { clearTimeout(timer); resolve(found); } });
    bonjour.find({ type: 'wifiroom' }, async (svc) => {
      const found = svc.txt?.url;
      if (!/^http:\/\/[\d.]+:\d+\/$/.test(found ?? '')) return;
      if (await isRoom(found, 3000)) { clearTimeout(timer); resolve(found); }
    });
  });
  bonjour.destroy();
  if (!url) return false;
  console.log(`\n  🏠 A room is already open on this Wi-Fi: ${url}`);
  console.log('     To open your own room instead, run: npx wifiroom --host');
  // Browsers only allow the microphone (for calls) on secure pages, and http://localhost counts as one while
  // http://192.168.x.x doesn't. So the room opens through a small forwarder on this computer's localhost.
  const net = await import('node:net');
  const { hostname, port } = new URL(url);
  const proxy = net.createServer((local) => {
    const remote = net.connect(Number(port), hostname);
    local.pipe(remote).pipe(local);
    local.on('error', () => remote.destroy());
    remote.on('error', () => local.destroy());
  });
  const listening = await new Promise((resolve) => {
    proxy.once('error', () => resolve(false));
    proxy.listen(Number(values.port), '127.0.0.1', () => resolve(true));
  });
  const open = (to) => !values['no-open'] && import('open').then(({ default: o }) => o(to)).catch(() => {});
  if (!listening) {
    console.log(`     Port ${values.port} is busy here, so opening it directly (calls won't work). Free the port to get calls.\n`);
    await open(url);
    process.exit(0);
  }
  const local = `http://localhost:${values.port}/`;
  console.log(`     Joined at ${local} · keep this running while you're in the room (Ctrl+C to leave)\n`);
  await open(local);
  return true;
}

function isRoom(url, ms) {
  return fetch(`${url}room.json`, { signal: AbortSignal.timeout(ms) }).then((r) => r.json()).then((b) => b.wifiroom === true, () => false);
}

async function scanForRoom() {
  const os = await import('node:os');
  const me = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address;
  if (!me) return null;
  const base = me.split('.').slice(0, 3).join('.');
  const asks = Array.from({ length: 254 }, (_, i) => `http://${base}.${i + 1}:4321/`).filter((url) => !url.includes(`//${me}:`))
    .map(async (url) => ((await isRoom(url, 2500)) ? url : Promise.reject()));
  return Promise.any(asks).catch(() => null);
}
