# WiFiRoom 🏠

**See who's on your Wi-Fi, as characters in a tiny pixel room.**

```bash
npx wifiroom
```

WiFiRoom runs locally on your computer, and nothing leaves your network. It never scans your network: it only listens to what devices already announce.

<!-- TODO: add demo GIF here -->

## What you can do

- **👻 Spot strangers.** Every unknown device on your Wi-Fi walks in as a ghost. Name it or trust it and it becomes a person.
- **🔔 Get alerted** when an unknown device joins your network.
- **🕒 See who's home.** Nickname the phones in your house, and the timeline shows who arrived and left, and when.
- **👉 Poke a device** to check it's alive. It sends a real ping, and the character hops with the reply time.
- **📲 Hang out on the same Wi-Fi.** Start with `--share` and friends scan a QR code to join from any phone (Android, iPhone, laptop). No app, account or internet needed. Chat, send emoji, and drop YouTube or Instagram links straight onto someone's screen.
- **📡 Bluetooth radar** *(experimental)*. See Bluetooth devices around you at their rough distance.

## Usage

```bash
npx wifiroom              # just you
npx wifiroom --share      # let people on your Wi-Fi join with a code
npx wifiroom --port 5000  # use another port
npx wifiroom --help
```

Requires [Node.js](https://nodejs.org) 20 or newer.

**Sharing is off by default.** Without `--share`, only your computer can open the room. With it, anyone on your Wi-Fi who has the 6-digit code (new every start) can join. Only use `--share` on networks you trust.

**Bluetooth on macOS:** run it from Terminal (or iTerm) and click **Allow** when macOS asks. Without permission, everything else still works.

## Control your devices

WiFiRoom detects what each device announces on your Wi-Fi and shows only the controls it supports. You don't need to set up your TV brand.

| Device announces | Usually | What you can do |
|---|---|---|
| Google Cast | Google TV / Android TV (Sony, TCL, Mi, OnePlus, Hisense, Philips…), Chromecast, Nest speakers | Play YouTube links and video/music URLs, volume, stop |
| DLNA media renderer | Most smart TVs and many speakers | Play video/music URLs, pause/resume/stop, volume |
| A real hardware address | PCs, NAS boxes, some TVs | **Wake** it with Wake-on-LAN, even after it's gone offline |
| A phone that joined the room | Any phone with the page open | **🔔 Ring** it: loud beeps, vibration and a flashing screen |

YouTube on Cast devices uses YouTube's unofficial remote interface, which could stop working if YouTube changes it. DLNA can't play YouTube links, only direct media URLs.

## Use it from your AI (Claude, Cursor, ChatGPT)

WiFiRoom works as an [MCP](https://modelcontextprotocol.io) server, so your own AI app can use your network as tools. It runs on the AI subscription you already have, with no API keys and no extra cost.

> "What's on my Wi-Fi?" · "Is the printer online?" · "Play this video on the living room TV and set volume to 20" · "Wake my desktop" · "Ring Rahul's phone"

**Claude Desktop:** add this to your config (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "wifiroom": { "command": "npx", "args": ["-y", "github:hariharapanigrahy/wifiroom", "mcp"] }
  }
}
```

**Claude Code:**

```bash
claude mcp add wifiroom -- npx -y github:hariharapanigrahy/wifiroom mcp
```

**Cursor and others:** use the same command, `npx -y github:hariharapanigrahy/wifiroom mcp`.

Tools: `list_devices`, `poke_device`, `play_on_device`, `control_media`, `wake_device`, `ring_phone`, `send_link`, `say_in_room`, `who_was_home`. If WiFiRoom is already running, the MCP server connects to it; otherwise it starts one in the background.

## Privacy

| | |
|---|---|
| Network scanning | **None.** WiFiRoom reads your computer's existing ARP table and listens for Bonjour/mDNS announcements |
| Data leaving your network | **None** from WiFiRoom itself: no analytics, accounts or cloud. Playing a YouTube link asks your TV to load it from YouTube |
| Where your labels live | `~/.wifiroom/db.json` on your computer |
| What visitors see (with `--share`) | Names and characters only. Never IP addresses, MAC addresses, the timeline or Bluetooth data |
| Poke | Sends one ping to the device you clicked |
| Device control | Only when you (or your AI) ask, and only to the device you picked |

## Honest limits

- **Phones show up as "Mystery phone?".** Modern phones and laptops use a private (random) Wi-Fi address, so their maker is hidden. Nickname them, or ask them to join with `--share`.
- **Departures are slow.** Your computer remembers devices for up to ~20 minutes, so "left" lags behind reality.
- **Bluetooth gives distance, not direction.** Distance is estimated from signal strength (±50%), and Bluetooth can't sense direction. Drag a blip to where the device really is.
- **Messages only reach people who joined.** Nothing is pushed to a phone that hasn't opened the room in its browser.

## Platforms

| | macOS | Windows | Linux |
|---|---|---|---|
| Room, alerts, timeline, poke, sharing | ✅ tested | should work, untested | should work, untested |
| Bluetooth radar | ✅ (with Terminal permission) | should work, untested | should work, untested |

Bug reports from Windows and Linux are very welcome.

## Built from

WiFiRoom is glue between open-source packages. Every direct dependency is MIT licensed:

| Job | Package |
|---|---|
| Game engine | [phaser](https://github.com/phaserjs/phaser) |
| Web server and realtime room | [express](https://github.com/expressjs/express), [socket.io](https://github.com/socketio/socket.io) |
| Device names (Bonjour) | [bonjour-service](https://github.com/onlxltd/bonjour-service) |
| Device list (ARP) | [@network-utils/arp-lookup](https://github.com/justintaddei/arp-lookup) |
| Device maker | [@network-utils/vendor-lookup](https://github.com/mfucci/vendor-lookup) |
| Poke | [ping](https://github.com/danielzzz/node-ping) |
| Cast / DLNA / Wake-on-LAN | [castv2-client](https://github.com/thibauts/node-castv2-client), [node-ssdp](https://github.com/diversario/node-ssdp), [upnp-mediarenderer-client](https://github.com/thibauts/node-upnp-mediarenderer-client), [wake_on_lan](https://github.com/agnat/node_wake_on_lan) |
| YouTube on Cast | [youtube-remote](https://github.com/alxhotel/youtube-remote) |
| AI tools (MCP) | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk), [socket.io-client](https://github.com/socketio/socket.io), [zod](https://github.com/colinhacks/zod) |
| Bluetooth (optional) | [@stoprocent/noble](https://github.com/stoprocent/noble) |
| Invite QR code | [qrcode](https://github.com/soldair/node-qrcode) |
| Storage | [lowdb](https://github.com/typicode/lowdb) |
| Open browser | [open](https://github.com/sindresorhus/open) |
| Pixel art | [Kenney Tiny Dungeon](https://kenney.nl/assets/tiny-dungeon) (CC0) |

Transitive dependencies (the packages these pull in) also include other permissive licenses: ISC, BSD-2, BSD-3, Apache-2.0 and public domain. Most come from Express, qrcode, and the optional Bluetooth module's installer. See the full list with:

```bash
npx license-checker-rseidelsohn --production --summary
```

`npm audit` reports one advisory, in `braces`, which is used only by `patch-package` during the optional Bluetooth module's install. It isn't used at runtime, and no fixed version exists.

## License

MIT
