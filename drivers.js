// Device control glue. Each driver wraps an existing package and attaches capabilities to
// devices by IP address once it sees them announce a protocol on the network.
import { createRequire } from 'node:module';
import { homeAt, homeAction, HOME_ACTIONS } from './home.js';
import { startScreen, stopScreen, sharingTo, airplayMirror, airplaySharingTo, onScreenChange } from './screen.js';
const require = createRequire(import.meta.url);
const { Client: CastClient, DefaultMediaReceiver, Application: CastApp, JsonController } = require('castv2-client');
const { inherits } = require('node:util');
const { Client: SsdpClient } = require('node-ssdp');
const MediaRendererClient = require('upnp-mediarenderer-client');
const wol = require('wake_on_lan');
const YoutubeRemote = require('youtube-remote');

const casts = new Map();  // ip -> { name, port }
const dlnas = new Map();  // ip -> { location, name }
const airplays = new Map(); // ip -> AirPlay name (for experimental macOS mirroring)

const youtubeId = (url) => {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    if (u.hostname.endsWith('youtube.com')) return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
  } catch {}
  return null;
};

const guessType = (url) => (/\.(mp3|m4a|aac|flac|wav|ogg)(\?|$)/i.test(url) ? 'audio/mpeg' : /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url) ? 'image/jpeg' : 'video/mp4');

// ---- Google Cast (Chromecast, Google TV, Android TV, Nest speakers) ----
function withCast(ip, fn) {
  return new Promise((resolve, reject) => {
    const client = new CastClient();
    let finished = false;
    const done = (err, val) => { if (finished) return; finished = true; client.close(); err ? reject(err) : resolve(val); };
    client.on('error', (err) => done(err));
    client.connect({ host: ip, port: casts.get(ip)?.port ?? 8009 }, () => fn(client, done));
  });
}

const cast = {
  async play(ip, url) {
    const vid = youtubeId(url);
    if (vid) return castYoutube(ip, vid);
    return withCast(ip, (client, done) => client.launch(DefaultMediaReceiver, (err, player) => {
      if (err) return done(err);
      // load() answers while the TV is still fetching, so wait for it to start or fail (e.g. a dead link).
      const timer = setTimeout(() => done(null, 'Playing'), 10000);
      player.on('status', (st) => {
        if (st.playerState === 'PLAYING' || st.playerState === 'PAUSED') { clearTimeout(timer); done(null, 'Playing'); }
        if (st.idleReason === 'ERROR') { clearTimeout(timer); done(new Error("The TV couldn't play that link")); }
      });
      player.load({ contentId: url, contentType: guessType(url), streamType: 'BUFFERED' }, { autoplay: true }, (e) => { if (e) { clearTimeout(timer); done(e); } });
    }));
  },
  // Screen sharing: a live HLS stream served from this computer.
  playLive: (ip, url) => withCast(ip, (client, done) => client.launch(DefaultMediaReceiver, (err, player) => {
    if (err) return done(err);
    player.load({ contentId: url, contentType: 'application/x-mpegURL', streamType: 'LIVE' }, { autoplay: true }, (e) => done(e, 'Sharing screen'));
  })),
  setVolume: (ip, level) => withCast(ip, (client, done) => client.setVolume({ level: Math.max(0, Math.min(1, level / 100)) }, (e) => done(e, `Volume ${level}%`))),
  // Stops whatever app is showing, not just our own (client.stop() wants an app object and crashes on a session).
  stop: (ip) => withCast(ip, (client, done) => client.getSessions((err, sessions) => {
    if (err || !sessions?.length) return done(err, 'Nothing playing');
    client.receiver.stop(sessions[0].sessionId, (e) => done(e, 'Stopped'));
  })),
  pause: (ip) => castMedia(ip, 'pause', 'Paused'),
  resume: (ip) => castMedia(ip, 'play', 'Playing'),
};

// Pause/resume whatever media the TV is playing (YouTube, our own player, other apps that use Cast media).
const castMedia = (ip, command, message) => withCast(ip, (client, done) => client.getSessions((err, sessions) => {
  const session = sessions?.find((s) => s.namespaces?.some((n) => n.name === 'urn:x-cast:com.google.cast.media'));
  if (err || !session) return done(err, 'Nothing playing');
  client.join(session, DefaultMediaReceiver, (e, player) => {
    if (e) return done(e);
    player.getStatus((e2, status) => (e2 || !status ? done(e2, 'Nothing playing') : player[command]((e3) => done(e3, message))));
  });
}));

// YouTube on Cast devices: the TV's YouTube app tells us its screen id, youtube-remote plays the video.
// This uses YouTube's unofficial remote interface and may break if YouTube changes it.
function CastYoutube(client, session) {
  CastApp.apply(this, arguments);
  this.mdx = this.createController(JsonController, 'urn:x-cast:com.google.youtube.mdx');
}
inherits(CastYoutube, CastApp);
CastYoutube.APP_ID = '233637DE';

async function castYoutube(ip, videoId) {
  const screenId = await withCast(ip, (client, done) => client.launch(CastYoutube, (err, app) => {
    if (err) return done(err);
    const timer = setTimeout(() => done(new Error('The TV did not open YouTube')), 15000);
    app.mdx.on('message', (msg) => { if (msg?.data?.screenId) { clearTimeout(timer); done(null, msg.data.screenId); } });
    app.mdx.send({ type: 'getMdxSessionStatus' });
  }));
  await new Promise((resolve, reject) => new YoutubeRemote(screenId).playVideo(videoId, (err) => (err ? reject(err) : resolve())));
  return 'Playing on YouTube';
}

// ---- DLNA / UPnP media renderers (most smart TVs and many speakers) ----
const dlnaClient = (ip) => new MediaRendererClient(dlnas.get(ip).location);
const dlnaCall = (ip, method, ...args) => new Promise((resolve, reject) => dlnaClient(ip)[method](...args, (err, res) => (err ? reject(err) : resolve(res))));

const dlna = {
  async play(ip, url) {
    if (youtubeId(url)) throw new Error('DLNA can\'t play YouTube links; use a direct video or music link');
    await dlnaCall(ip, 'load', url, { autoplay: true, contentType: guessType(url) });
    return 'Playing';
  },
  setVolume: async (ip, level) => { await dlnaCall(ip, 'setVolume', Math.round(level)); return `Volume ${level}%`; },
  pause: async (ip) => { await dlnaCall(ip, 'pause'); return 'Paused'; },
  resume: async (ip) => { await dlnaCall(ip, 'play'); return 'Playing'; },
  stop: async (ip) => { await dlnaCall(ip, 'stop'); return 'Stopped'; },
};

// ---- discovery ----
export function startDrivers({ bonjour, onChange }) {
  onScreenChange(onChange);
  // Only macOS can mirror to AirPlay (and only experimentally), so don't offer it elsewhere.
  if (process.platform === 'darwin') bonjour.find({ type: 'airplay' }, (svc) => {
    const ip = (svc.addresses ?? []).find((a) => a.includes('.'));
    if (!ip || airplays.has(ip)) return;
    airplays.set(ip, svc.name);
    onChange();
  });

  bonjour.find({ type: 'googlecast' }, (svc) => {
    const ip = (svc.addresses ?? []).find((a) => a.includes('.'));
    if (!ip) return;
    casts.set(ip, { name: svc.txt?.fn || svc.name, port: svc.port });
    onChange();
  });

  const ssdp = new SsdpClient();
  ssdp.on('response', (headers, _code, rinfo) => {
    if (!dlnas.has(rinfo.address)) {
      dlnas.set(rinfo.address, { location: headers.LOCATION });
      onChange();
    }
  });
  const search = () => ssdp.search('urn:schemas-upnp-org:device:MediaRenderer:1');
  search();
  setInterval(search, 60_000);
}

// What a device at this IP can do. `mac` enables Wake-on-LAN for devices with a real hardware address.
export function capabilitiesOf(ip, { mac, randomMac, isSelf } = {}) {
  const caps = [];
  if (casts.has(ip)) caps.push('cast');
  if (dlnas.has(ip)) caps.push('dlna');
  if (!isSelf && (casts.has(ip) || dlnas.has(ip) || airplays.has(ip))) caps.push('screen');
  if (homeAt(ip).length) caps.push('home');
  if (mac && !randomMac && !mac.startsWith('02:00:00')) caps.push('wake');
  return caps;
}

// Which device this computer's screen is currently shown on, if any.
export const screenTarget = () => sharingTo() ?? airplaySharingTo();

export const castName = (ip) => casts.get(ip)?.name ?? null;

// Run an action on a device. Prefers Cast, then DLNA (then AirPlay for screen sharing).
export async function runAction({ ip, mac }, action, args = {}) {
  const viaCast = casts.has(ip), viaDlna = dlnas.has(ip);
  // Smart-home actions go to the device's entity; a Hue bridge or power strip can have several.
  if (HOME_ACTIONS.includes(action)) {
    const here = homeAt(ip);
    const entity = args.entity ? here.find((e) => e.id === args.entity) : here.length === 1 ? here[0] : null;
    if (!entity) throw new Error(here.length ? 'Pick which light or plug (args.entity)' : `This device doesn't support "${action}"`);
    return homeAction(entity.id, action, args.value);
  }
  const pick = (name) => (viaCast && cast[name] ? cast : viaDlna && dlna[name] ? dlna : null);
  switch (action) {
    case 'play': {
      if (viaCast) return cast.play(ip, args.url);
      if (viaDlna) return dlna.play(ip, args.url);
      break;
    }
    case 'volume': {
      const d = pick('setVolume');
      if (d) return d.setVolume(ip, Number(args.level));
      break;
    }
    case 'pause': case 'resume': case 'stop': {
      const d = pick(action);
      if (d) return d[action](ip);
      break;
    }
    case 'screen_start': {
      if (viaCast) { await startScreen({ ip, kind: 'hls', play: (url) => cast.playLive(ip, url), stopTv: () => cast.stop(ip) }); return 'Sharing your screen (a few seconds behind)'; }
      if (viaDlna) { await startScreen({ ip, kind: 'ts', play: (url) => dlnaCall(ip, 'load', url, { autoplay: true, contentType: 'video/mp2t' }), stopTv: () => dlnaCall(ip, 'stop') }); return 'Sharing your screen (a few seconds behind)'; }
      if (airplays.has(ip)) return airplayMirror(ip, airplays.get(ip), true);
      break;
    }
    case 'screen_stop': {
      if (airplaySharingTo() === ip) return airplayMirror(ip, airplays.get(ip), false);
      if (sharingTo() !== ip) return 'Not sharing to this device';
      return stopScreen();
    }
    case 'wake': {
      if (!mac) break;
      await new Promise((resolve, reject) => wol.wake(mac, (err) => (err ? reject(err) : resolve())));
      return 'Wake signal sent';
    }
  }
  throw new Error(`This device doesn't support "${action}"`);
}
