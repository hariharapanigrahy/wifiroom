# Launch notes

Drafts for announcing 0.4. Edit freely; keep the claims to what's tested.

## One line

WiFiRoom: a private intranet for one Wi-Fi. Chat, files, games, a program and live video for everyone in the room. No internet, no accounts, no cloud. `npx wifiroom --share`.

## Show HN

**Title:** Show HN: WiFiRoom – chat, files, games and live video for everyone on one Wi-Fi, no internet

**Text:**
WiFiRoom turns one Wi-Fi into a private intranet. One person runs `npx wifiroom --share` (or the Android app); everyone else opens the address, picks a name, and they're in: channels and encrypted DMs, device-to-device file sharing (you allow a folder, nothing is uploaded), voice calls, chess / Ludo / cards / Hold'em with a scoreboard, a schedule with polls and sign-ups, and "Live": play a video or share your screen and everyone watches in sync.

Nothing leaves the network. No accounts: your name is tied to a key your browser keeps, with a fingerprint next to it so nobody can pass for you, and a sealed code to carry it to another device. The host can lock the room or remove someone.

It's plain HTML/JS served by one Node process, no build step, built on Phaser, Preact, tweetnacl, Socket.IO, chess.js and pokersolver. Started as "who's on my Wi-Fi, as pixel characters" and grew into this because a hostel floor, a game night and a flight all want the same thing.

Honest limits: live video is one stream per viewer from the owner's device, so a handful of viewers, not a hall. Some routers keep the 2.4 and 5 GHz bands apart and then two devices can't reach each other directly; file transfers fall back to passing through the host, encrypted. Calls need the page on localhost or the app.

## Reddit (r/selfhosted, r/opensource, r/privacy, r/androidapps)

Title: I made an "intranet in a box" for one Wi-Fi: chat, file sharing, games, live video, no internet needed (open source, one command)

Body: the Show HN text, plus the screenshots, plus "What would you use it for?" as the closing question. r/privacy: lead with the identity and host-powers section of the README.

## Product Hunt

Tagline: The internet, but for one Wi-Fi.
First comment: the Show HN text, shortened; the four phone screenshots.

## GitHub

Topics: `wifi`, `lan`, `lan-party`, `offline`, `local-first`, `intranet`, `chat`, `file-sharing`, `webrtc`, `games`, `chess`, `poker`, `nodejs`, `preact`, `phaser`, `privacy`, `self-hosted`, `android`.

Release notes for 0.4.0: the "What's in the room" and "Safe with strangers" sections of the README, plus "Upgrading: `~/.wifiroom/` gains channels.json, program.json and games.json; nothing else changes."

## Who to tell

Hostel and dorm communities, board-game and LAN-party groups, teachers (classroom without internet), event organizers, ferry/flight/offline travel forums, the Phaser and Preact communities (it's a showcase of both).
