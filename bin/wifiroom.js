#!/usr/bin/env node
// Command-line entry: `npx wifiroom [command] [--share] [--port 4321] [--no-open]`
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    share: { type: 'boolean', default: false },
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
} else {
  process.env.WIFIROOM_SHARE = values.share ? '1' : '0';
  process.env.WIFIROOM_CODE = values.code ? '1' : '0';
  process.env.WIFIROOM_OPEN = values['no-open'] || command === 'serve' ? '0' : '1';
  process.env.WIFIROOM_PASSIVE = values.passive ? '1' : '0';
  await import(command === 'mcp' ? '../mcp.js' : '../server.js');
}
