#!/usr/bin/env node
// Command-line entry: `npx wifiroom [--share] [--port 4321] [--no-open]`
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    share: { type: 'boolean', default: false },
    port: { type: 'string', default: '4321' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`
  WiFiRoom: see who's on your Wi-Fi, as characters in a tiny pixel room.

  Usage: npx wifiroom [options]
         npx wifiroom mcp        Run as an MCP server for Claude Desktop, Cursor, etc.

    --share       Let phones on your Wi-Fi join the room (they need a 6-digit code)
    --port <n>    Port to use (default 4321)
    --no-open     Don't open the browser automatically
    -h, --help    Show this help
`);
  process.exit(0);
}

process.env.WIFIROOM_PORT = values.port;
process.env.WIFIROOM_SHARE = values.share ? '1' : '0';
process.env.WIFIROOM_OPEN = values['no-open'] ? '0' : '1';
await import(positionals[0] === 'mcp' ? '../mcp.js' : '../server.js');
