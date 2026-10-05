# Contributing

Thanks for looking. WiFiRoom is glue between good open-source pieces, kept deliberately small: plain HTML and JS with no build step, one Node process, no accounts, nothing leaving the Wi-Fi.

## Run it from a checkout

```bash
git clone https://github.com/hariharapanigrahy/wifiroom && cd wifiroom
npm install
node bin/wifiroom.js --share
```

Open `http://localhost:4321`. Other devices on the Wi-Fi open the address it prints. The host's data lives in `~/.wifiroom/`; delete that folder for a fresh start.

## Where things are

| | |
|---|---|
| `server.js` | the room: devices, the pixel room, sockets, the local HTTP API |
| `channels.js` | people (identity, names, fingerprints, linking, host powers) and channels |
| `program.js` | schedule, polls, sign-ups |
| `games.js` | the game runner (seats, turns, per-player views) and every game's rules |
| `shares.js` | folders people allow, and live shows |
| `public/room.js` | the pixel room (Phaser) |
| `public/chat.js`, `public/p2p.js` | encrypted direct messages, device-to-device files, calls, live streams |
| `public/channels.js` | the channel UI |
| `public/program.js` | Program, Games, Files and People panes (Preact + htm) |

## Adding a game

A game is an object in `games.js` with `create()`, `step(g, state, uid, action, data, runs)` and optionally `view(state, uid, g)` for what each player may see, plus `min`/`max` seats. Write the rules first, then a simulation that plays random legal moves (see the commit messages for Ludo, Crazy Eights and Hold'em for the invariants we check: cards or chips conserved, a winner always reached, out-of-turn moves ignored), then the table in `public/program.js`.

## Ground rules

- No build step, no framework migrations, no telemetry, no servers outside the Wi-Fi.
- Prefer a small, well-maintained package over writing it ourselves (chess.js, pokersolver, tweetnacl, lowdb), and prefer writing it ourselves over a large dependency.
- Anything a stranger on public Wi-Fi could abuse needs a check on the host: who may call it, how often, how big.
- Say what the code does in comments only where the *why* isn't obvious.

Bug reports with the output of `npx wifiroom` and the browser console are the most useful kind. Windows and Linux reports especially.
