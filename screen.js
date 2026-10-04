// Screen sharing glue: the system's ffmpeg captures this screen, a tiny HTTP listener on the LAN
// serves the stream, and the caller tells the TV (Cast or DLNA) to play its URL.
// ffmpeg is not bundled: we only use one the user already installed.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

let session = null; // { ip, kind, ffmpeg, server, dir, stop }
let changed = () => {};
export const onScreenChange = (fn) => { changed = fn; };
export const sharingTo = () => session?.ip ?? null;

export function findFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  return dirs.map((d) => path.join(d, exe)).find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) ?? null;
}

const INSTALL_HINT = { darwin: 'brew install ffmpeg', win32: 'winget install ffmpeg', linux: 'sudo apt install ffmpeg' }[process.platform] ?? 'install ffmpeg';

// Pick this computer's address on the same subnet as the TV, so the TV can reach the stream.
function lanIpFor(target) {
  const toInt = (a) => a.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
  const all = Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4' && !a.internal);
  const same = all.find((a) => ((toInt(a.address) & toInt(a.netmask)) >>> 0) === ((toInt(target) & toInt(a.netmask)) >>> 0));
  return (same ?? all[0])?.address;
}

// macOS: avfoundation numbers screens after cameras, so ask ffmpeg which index is "Capture screen 0".
function macScreenIndex(ffmpeg) {
  return new Promise((resolve) => execFile(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 8000 }, (_err, _out, stderr) => {
    resolve(String(stderr).match(/\[(\d+)\] Capture screen 0/)?.[1] ?? null);
  }));
}

async function captureArgs(ffmpeg) {
  if (process.platform === 'darwin') {
    const idx = await macScreenIndex(ffmpeg);
    if (idx === null) throw new Error(screenPermissionError());
    return ['-f', 'avfoundation', '-framerate', '30', '-capture_cursor', '1', '-i', `${idx}:none`];
  }
  if (process.platform === 'win32') return ['-f', 'gdigrab', '-framerate', '30', '-i', 'desktop'];
  return ['-f', 'x11grab', '-framerate', '30', '-i', process.env.DISPLAY || ':0.0'];
}

// Low-latency H.264: 1 s keyframes so the TV can start quickly. `fps=30` also fixes avfoundation's
// unusable timestamps, and scaling keeps Retina/4K screens within what TVs decode comfortably.
const ENCODE = ['-vf', "fps=30,scale='min(1920,iw)':-2,format=yuv420p", '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
  '-profile:v', 'main', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-b:v', '5M', '-maxrate', '5M', '-bufsize', '10M', '-an'];

function screenPermissionError() {
  if (process.platform !== 'darwin') return 'ffmpeg could not capture the screen';
  return 'macOS blocked screen capture. Open System Settings → Privacy & Security → Screen & System Audio Recording, turn on the app you started WiFiRoom from (Terminal, iTerm, Claude…), then restart it';
}

function explain(stderr) {
  if (/Unknown encoder 'libx264'/.test(stderr)) return 'This ffmpeg was built without libx264 (H.264). Install a full build, e.g. ' + INSTALL_HINT;
  if (process.platform === 'darwin' && /avfoundation|AVCapture|Input\/output error|not permitted|Could not|failed/i.test(stderr)) return screenPermissionError();
  if (process.platform === 'linux' && /x11grab|Cannot open display/i.test(stderr)) return 'ffmpeg could not open the X11 display. Screen sharing needs an X11 session (Wayland is not supported)';
  return `ffmpeg stopped: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`;
}

// A minimal listener on the LAN address that serves only this session's stream files, under a
// random path, and only while sharing. The main WiFiRoom UI can stay bound to 127.0.0.1.
function listen(host, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
  });
}

const waitFor = async (check, ms, failed) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
    if (failed()) return false;
    if (check()) return true;
  }
  return false;
};

function kill(child) {
  if (!child || child.exitCode !== null) return;
  try { child.stdin.write('q'); } catch {}
  child.kill('SIGTERM');
  // avfoundation can ignore SIGTERM while waiting on the screen, so make sure it really stops.
  setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000).unref();
}

// kind 'hls' (Cast) or 'ts' (DLNA). `play(url)` tells the TV to open it; `stopTv()` stops it.
export async function startScreen({ ip, kind, play, stopTv }) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error(`Screen sharing needs ffmpeg. Install it (${INSTALL_HINT}) and try again`);
  if (session) await stopScreen();
  const host = lanIpFor(ip);
  if (!host) throw new Error('This computer has no Wi-Fi/LAN address');

  const token = randomBytes(18).toString('base64url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifiroom-screen-'));
  const input = await captureArgs(ffmpeg);
  const output = kind === 'hls'
    ? ['-f', 'hls', '-hls_time', '1', '-hls_list_size', '6', '-hls_flags', 'delete_segments+independent_segments+omit_endlist', '-hls_segment_filename', path.join(dir, 'seg%05d.ts'), path.join(dir, 'index.m3u8')]
    : ['-f', 'mpegts', '-flush_packets', '1', 'pipe:1'];
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...input, ...ENCODE, ...output], { stdio: ['pipe', kind === 'ts' ? 'pipe' : 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-4000); });
  child.on('error', (err) => { stderr += err.message; });

  // MPEG-TS over HTTP: every TV connection gets the live stream from the moment it joins.
  const viewers = new Set();
  let gotData = false;
  child.stdout?.on('data', (chunk) => { gotData = true; for (const res of viewers) res.write(chunk); });

  const server = await listen(host, (req, res) => {
    const [, tok, file] = req.url.split('?')[0].split('/');
    const ok = (req.method === 'GET' || req.method === 'HEAD') && tok === token && (kind === 'hls' ? /^(index\.m3u8|seg\d{5}\.ts)$/.test(file) : file === 'live.ts');
    if (!ok) { res.writeHead(404).end(); return; }
    res.setHeader('Access-Control-Allow-Origin', '*'); // the Cast receiver fetches HLS from a web page
    res.setHeader('Cache-Control', 'no-cache');
    if (kind === 'ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'transferMode.dlna.org': 'Streaming', 'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000' });
      if (req.method === 'HEAD') return res.end();
      viewers.add(res);
      req.on('close', () => viewers.delete(res));
      return;
    }
    fs.readFile(path.join(dir, file), (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });

  const cleanup = () => {
    kill(child);
    for (const res of viewers) res.end();
    server.close();
    server.closeAllConnections?.();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const me = { ip, kind, stop: async () => { await stopTv().catch(() => {}); cleanup(); } };
  child.on('exit', () => { if (session === me) { session = null; cleanup(); changed(); } });

  // Wait until ffmpeg is actually producing video before pointing the TV at it.
  const ready = await waitFor(() => (kind === 'hls' ? fs.existsSync(path.join(dir, 'index.m3u8')) : gotData), 15_000, () => child.exitCode !== null);
  if (!ready) { cleanup(); throw new Error(child.exitCode !== null ? explain(stderr) : `${screenPermissionError()} (no video after 15 s)`); }

  const url = `http://${host}:${server.address().port}/${token}/${kind === 'hls' ? 'index.m3u8' : 'live.ts'}`;
  session = me;
  try {
    await play(url);
  } catch (err) {
    session = null;
    cleanup();
    throw err;
  }
  changed();
  return { url };
}

export async function stopScreen() {
  const s = session;
  session = null;
  if (!s) return 'Not sharing';
  await s.stop();
  changed();
  return 'Stopped sharing';
}

// Never leave ffmpeg running after WiFiRoom exits.
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.once(sig, () => { session?.stop(); if (sig !== 'exit') process.exit(); });

// ---- AirPlay (macOS only, EXPERIMENTAL) ----
// macOS has no public command for screen mirroring, so this clicks Control Center's Screen Mirroring
// menu with AppleScript UI scripting. It needs Accessibility permission and can break whenever Apple
// changes the menu layout.
const AIRPLAY_SCRIPT = `
on run argv
  set deviceName to item 1 of argv
  tell application "System Events"
    tell process "ControlCenter"
      set mirroring to missing value
      repeat with mbi in menu bar items of menu bar 1
        try
          if description of mbi contains "Screen Mirroring" then set mirroring to mbi
        end try
      end repeat
      if mirroring is missing value then
        set cc to (first menu bar item of menu bar 1 whose description is "Control Center")
        click cc
        delay 1
        set found to false
        repeat with el in (entire contents of window 1)
          try
            if (description of el contains "Screen Mirroring") or (name of el contains "Screen Mirroring") then
              click el
              set found to true
              exit repeat
            end if
          end try
        end repeat
        if not found then
          key code 53
          return "ERR:menu"
        end if
      else
        click mirroring
      end if
      delay 2
      repeat with el in (entire contents of window 1)
        try
          if (name of el contains deviceName) or (description of el contains deviceName) or (title of el contains deviceName) then
            click el
            delay 0.5
            key code 53
            return "OK"
          end if
        end try
      end repeat
      key code 53
      return "ERR:device"
    end tell
  end tell
end run`;

let airplayTo = null;
export const airplaySharingTo = () => airplayTo;

function runAirplayScript(name) {
  return new Promise((resolve, reject) => execFile('osascript', ['-e', AIRPLAY_SCRIPT, name], { timeout: 20_000 }, (err, stdout, stderr) => {
    const out = String(stdout).trim();
    if (/-1719|-25211|assistive access|not allowed/i.test(stderr)) return reject(new Error('Mirroring to AirPlay needs Accessibility permission: System Settings → Privacy & Security → Accessibility, turn on the app you started WiFiRoom from, then try again'));
    if (out === 'ERR:menu') return reject(new Error("Couldn't find Screen Mirroring in Control Center (experimental feature; your macOS version may lay it out differently)"));
    if (out === 'ERR:device') return reject(new Error(`"${name}" didn't appear in the Screen Mirroring menu. Make sure the TV is on and AirPlay is enabled`));
    if (err) return reject(new Error(`AirPlay mirroring failed: ${String(stderr).trim() || err.message}`));
    resolve(out);
  }));
}

// Clicking the same device again in the menu toggles mirroring off.
export async function airplayMirror(ip, name, on) {
  if (process.platform !== 'darwin') throw new Error('AirPlay mirroring is only available on macOS');
  if (!on && airplayTo !== ip) return 'Not mirroring to this TV';
  await runAirplayScript(name);
  airplayTo = on ? ip : null;
  changed();
  return on ? `Mirroring to ${name} (experimental)` : 'Stopped mirroring';
}
