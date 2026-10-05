// Voice calls and file sharing between browsers in the room, over WebRTC. The room only passes along each
// browser's connection setup, sealed with the chat keys (see chat.js), so it can't read it or sit in the
// middle. Files go straight from browser to browser when they can reach each other; otherwise they come
// through the room in chunks, sealed with a one-time key that only the chat's members get.
const CHUNK = 60 * 1024;
const MAX_FILE = 200 * 1024 * 1024; // kept in memory until saved
const peers = new Map(); // deviceId -> { pc, polite, making, ignore, sender, audio }
const files = new Map(); // fileId -> { meta, url, mine, targets, done, failed, sending, from, key, parts, got }
let call = null;         // { id, chatId, stream, joined: Set<deviceId>, muted }

const hex = (n) => [...nacl.randomBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('');
const chatRef = (chat) => ({ id: chat.id, kind: chat.kind, name: chat.name, members: chat.members });
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const canCall = () => !!navigator.mediaDevices?.getUserMedia && !!window.RTCPeerConnection;
// Browsers allow the microphone only on https or localhost, and the room is plain http on the Wi-Fi.
const NO_MIC = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'This browser blocks the microphone.'
  : `Calls need the room open at localhost, not ${location.hostname}: on the host computer use http://localhost:${location.port || 80}, on another laptop run "npx wifiroom" (it opens the room that way), or use the WiFiRoom app.`;

// ---- connection setup, sealed for one person ----
function signal(to, msg) {
  const key = keyOf(to);
  if (!key) return;
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(new TextEncoder().encode(JSON.stringify(msg)), nonce, fromB64(key), chatKeyPair.secretKey);
  socket.emit('signal', { to, nonce: toB64(nonce), box: toB64(box) });
}

function unseal(from, nonce, box) {
  for (const key of new Set([keyOf(from), pins[from]].filter(Boolean))) {
    const plain = nacl.box.open(fromB64(box), fromB64(nonce), fromB64(key), chatKeyPair.secretKey);
    if (plain) try { return JSON.parse(new TextDecoder().decode(plain)); } catch { return null; }
  }
  return null;
}

// One connection per person, shared by calls and file transfers. Both sides may start talking at once, so
// this follows WebRTC's "perfect negotiation": the polite side gives way when offers cross.
function peer(id) {
  const old = peers.get(id);
  if (old && !['failed', 'closed'].includes(old.pc.connectionState)) return old;
  // No STUN or TURN servers: everyone is on the same Wi-Fi, and nothing should leave it.
  const pc = new RTCPeerConnection({ iceServers: [] });
  const p = { pc, polite: myId() > id, making: false, ignore: false, sender: null, audio: null };
  peers.set(id, p);
  pc.onnegotiationneeded = async () => {
    try { p.making = true; await pc.setLocalDescription(); signal(id, { sdp: pc.localDescription, call: call?.id, show: p.showStream }); } catch (e) { console.warn('WebRTC', e); } finally { p.making = false; }
  };
  pc.onicecandidate = ({ candidate }) => candidate && signal(id, { ice: candidate });
  pc.ondatachannel = ({ channel }) => receiveChannel(id, channel);
  pc.ontrack = ({ streams }) => { if (!showStreamArrived(p, streams[0])) hear(id, p, streams[0]); };
  pc.onconnectionstatechange = () => {
    console.log('WebRTC', personName(id), pc.connectionState);
    if (pc.connectionState === 'failed') { pc.close(); if (call?.joined.has(id)) addCallNote(`⚠️ No direct connection to ${personName(id)}: this Wi-Fi keeps the two devices apart.`); }
    if (call?.joined.has(id)) renderCall();
  };
  pc.oniceconnectionstatechange = () => { console.log('ICE', personName(id), pc.iceConnectionState); if (call?.joined.has(id)) renderCall(); };
  return p;
}

socket.on('signal', async ({ from, nonce, box }) => {
  const msg = unseal(from, nonce, box);
  if (!msg || !window.RTCPeerConnection) return;
  const p = peer(from), pc = p.pc;
  try {
    if (msg.sdp) {
      const collision = msg.sdp.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && collision;
      if (p.ignore) return;
      if (msg.show) p.remoteShowStream = msg.show; // the owner's show stream, so ontrack can tell it from a call
      await pc.setRemoteDescription(msg.sdp);
      if (msg.sdp.type === 'offer') {
        // Someone in our call connecting (in a group, people already talking reach each newcomer): answer with our voice.
        if (call && chats[call.chatId]?.members.includes(from) && msg.call === call.id) { call.joined.add(from); speakTo(p); renderCall(); }
        await pc.setLocalDescription();
        signal(from, { sdp: pc.localDescription, call: call?.id });
      }
    } else if (msg.ice) {
      try { await pc.addIceCandidate(msg.ice); } catch (e) { if (!p.ignore) throw e; }
    }
  } catch (e) { console.warn('WebRTC', e); }
});

// ---- files ----
// `list` holds Files, or File-like objects ({ name, size, type, slice }) for a folder the phone app shares.
function shareFiles(chat, list, { share } = {}) {
  for (const file of list) {
    if (file.size > MAX_FILE) { toast(`⚠️ ${file.name} is over ${fmtSize(MAX_FILE)}`); continue; }
    const key = nacl.randomBytes(nacl.secretbox.keyLength);
    const meta = { id: hex(8), name: file.name.slice(0, 200), size: file.size, mime: file.type || 'application/octet-stream' };
    const f = { meta, url: file instanceof Blob ? URL.createObjectURL(file) : null, mine: true, targets: 0, done: 0, failed: 0, sending: {}, share };
    files.set(meta.id, f);
    addMsg(chat, { from: myId(), file: meta, ts: Date.now() });
    renderChats();
    sendPayload(chat, { t: 'file', chat: chatRef(chat), file: { ...meta, key: toB64(key) } }, async (r) => {
      if (!r.ok) { addMsg(chat, { system: true, text: `⚠️ ${meta.name} not sent: ${r.error}`, ts: Date.now() }); return renderChats(); }
      const targets = others(chat).filter((id) => !r.missed.includes(id));
      f.targets = targets.length;
      if (r.missed.length) addMsg(chat, { system: true, text: `${meta.name} not sent to ${r.missed.map(personName).join(', ')}: not in the room right now.`, ts: Date.now() });
      await Promise.all(targets.map(async (to) => {
        try { await sendFileTo(to, file, f, key); f.done++; } catch (e) { f.failed++; addMsg(chat, { system: true, text: `⚠️ ${meta.name} didn't reach ${personName(to)}: ${e.message}`, ts: Date.now() }); }
        delete f.sending[to];
        refresh();
      }));
    });
  }
}

async function sendFileTo(to, file, f, key) {
  const channel = window.RTCPeerConnection ? await openDataChannel(to, f.meta.id).catch(() => null) : null;
  for (let at = 0; at < file.size; at += CHUNK) {
    if (f.aborted) { channel?.close(); throw new Error('the share was stopped'); }
    const chunk = new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer());
    if (channel) {
      if (channel.readyState !== 'open') throw new Error('the connection closed');
      if (channel.bufferedAmount > 4 * 1024 * 1024) await new Promise((ok) => { channel.onbufferedamountlow = ok; });
      channel.send(chunk);
    } else {
      const seq = at / CHUNK;
      const r = await socket.timeout(15_000).emitWithAck('relay', { to, file: f.meta.id, seq, chunk: nacl.secretbox(chunk, nonceFor(seq), key) }).catch(() => ({ ok: false }));
      if (!r.ok) throw new Error('they left the room');
    }
    f.sending[to] = (at + chunk.length) / file.size;
    refresh();
  }
  if (channel) while (channel.bufferedAmount > 0 && channel.readyState === 'open') await new Promise((ok) => setTimeout(ok, 100));
}

// A direct channel for one file, or a rejection if the two devices can't reach each other in a few seconds.
function openDataChannel(to, id) { // not openChannel: channels.js uses that name for chat channels
  const channel = peer(to).pc.createDataChannel(`file:${id}`);
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 1024 * 1024;
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => { channel.close(); fail(new Error('no direct route')); }, 6000);
    channel.onopen = () => { clearTimeout(timer); ok(channel); };
  });
}

const nonceFor = (seq) => { const n = new Uint8Array(nacl.secretbox.nonceLength); new DataView(n.buffer).setUint32(0, seq); return n; };

function receiveChannel(from, channel) {
  const id = channel.label.match(/^file:([0-9a-f]{16})$/)?.[1];
  const f = id && files.get(id);
  if (!f || f.from !== from) return channel.close();
  channel.binaryType = 'arraybuffer';
  channel.onmessage = ({ data }) => data instanceof ArrayBuffer && addPart(f, f.parts.length, new Uint8Array(data));
}

socket.on('relay', ({ from, file, seq, chunk }) => {
  const f = files.get(file);
  if (!f || f.from !== from || f.url) return;
  const plain = nacl.secretbox.open(new Uint8Array(chunk), nonceFor(seq), f.key);
  if (plain) addPart(f, seq, plain);
});

function addPart(f, index, bytes) {
  if (f.url || f.parts[index]) return;
  f.parts[index] = bytes;
  f.got += bytes.length;
  if (f.got >= f.meta.size) finishFile(f);
  else refresh();
}

function finishFile(f) {
  f.url = URL.createObjectURL(new Blob(f.parts, { type: f.meta.mime }));
  f.parts = null;
  toast(`📎 ${personName(f.from)} sent you ${f.meta.name}`);
  refresh();
}

// Called by chat.js for the sealed messages that set up files and calls.
function onP2p(from, chat, p) {
  if (p.t === 'file') {
    const m = p.file ?? {};
    if (!/^[0-9a-f]{16}$/.test(m.id) || typeof m.key !== 'string' || !(m.size >= 0 && m.size <= MAX_FILE) || files.has(m.id)) return;
    const meta = { id: m.id, name: String(m.name ?? 'file').slice(0, 200), size: m.size, mime: String(m.mime ?? '').slice(0, 100) || 'application/octet-stream' };
    const f = { meta, from, key: fromB64(m.key), parts: [], got: 0 };
    files.set(meta.id, f);
    addMsg(chat, { from, file: meta, ts: Date.now() }, { unread: true });
    if (meta.size === 0) finishFile(f);
    renderChats();
    return;
  }
  if (p.t === 'call') return incomingCall(from, chat, p.call);
  if (!call || p.call !== call.id) return;
  if (p.t === 'call-join') { call.joined.add(from); addCallNote(`${personName(from)} joined the call.`); connectCall(from, chat); }
  if (p.t === 'call-here' && !call.joined.has(from)) { call.joined.add(from); connectCall(from, chat); }
  if (p.t === 'call-leave') { leftCall(from); addCallNote(`${personName(from)} left the call.`); }
  if (p.t === 'call-decline') addCallNote(`${personName(from)} can't talk right now.`);
}

// How a file message looks in a chat: a link once it's here, progress while it's coming.
function fileView(m) {
  const f = files.get(m.file.id);
  const label = `📎 ${m.file.name} · ${fmtSize(m.file.size)}`;
  if (!f) return [label, el('span', { className: 'meta', textContent: 'No longer here: files stay only until the page is closed.' })];
  const link = f.url ? el('a', { href: f.url, download: m.file.name, textContent: label, onclick: (e) => saveFile(e, f) }) : label;
  if (f.mine && f.share) return [label, el('span', { className: 'meta', textContent: `From your shared folder · ${Object.values(f.sending).length ? `sending ${Math.floor(100 * Object.values(f.sending)[0])}%` : f.done ? 'sent' : f.failed ? 'not delivered' : 'starting…'}` })];
  let status;
  if (f.mine) {
    const going = Object.values(f.sending);
    status = going.length ? `Sending… ${Math.floor((100 * going.reduce((a, b) => a + b, 0)) / going.length)}%`
      : f.targets ? `Sent to ${f.done} of ${f.targets}${f.failed ? ` · ${f.failed} failed` : ''}` : 'Starting…';
  } else status = f.url ? 'Tap to save' : `Receiving… ${Math.floor((100 * f.got) / Math.max(1, f.meta.size))}%`;
  return [link, el('span', { className: 'meta', textContent: status })];
}

// The Android app's WebView can't save blob: links, so it offers a bridge that writes to Downloads.
async function saveFile(e, f) {
  const app = window.WiFiRoomApp;
  if (!app) return;
  e.preventDefault();
  const blob = await (await fetch(f.url)).blob();
  const handle = app.saveStart(f.meta.name, f.meta.mime);
  for (let at = 0; at < blob.size; at += 512 * 1024) {
    app.saveChunk(handle, toB64Big(new Uint8Array(await blob.slice(at, at + 512 * 1024).arrayBuffer())));
  }
  toast(app.saveEnd(handle) ? `💾 Saved ${f.meta.name} to Downloads` : `⚠️ Couldn't save ${f.meta.name}`);
}
const toB64Big = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

let refreshing = false;
function refresh() {
  if (refreshing) return;
  refreshing = true;
  setTimeout(() => { refreshing = false; renderChats(); }, 250);
}

// ---- calls ----
async function mic() {
  if (!canCall()) { toast(NO_MIC); return null; }
  try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { toast('🎙️ Microphone access was blocked'); return null; }
}

async function startCall(chat) {
  if (call) return toast('You are already in a call');
  const stream = await mic();
  if (!stream) return;
  call = { id: hex(8), chatId: chat.id, stream, joined: new Set(), muted: false };
  addCallNote('📞 You started a call.');
  sendPayload(chat, { t: 'call', chat: chatRef(chat), call: call.id });
  renderCall();
}

function incomingCall(from, chat, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return;
  // Both people dialed each other: the call with the smaller id wins, and the other side joins it.
  if (call && call.chatId === chat.id && !call.joined.size) {
    if (id > call.id) return sendPayload(chat, { t: 'call', chat: chatRef(chat), call: call.id }); // they join ours; tell them again in case they missed it
    call.id = id;
    call.joined.add(from);
    sendPayload(chat, { t: 'call-join', chat: chatRef(chat), call: id });
    return connectCall(from, chat);
  }
  if (call) return sendPayload(chat, { t: 'call-decline', chat: chatRef(chat), call: id });
  addMsg(chat, { system: true, text: `📞 ${personName(from)} called.`, ts: Date.now() }, { unread: true });
  const answer = async (yes) => {
    box.remove(); clearInterval(ringer);
    if (!yes) return sendPayload(chat, { t: 'call-decline', chat: chatRef(chat), call: id });
    const stream = await mic();
    if (!stream) return sendPayload(chat, { t: 'call-decline', chat: chatRef(chat), call: id });
    call = { id, chatId: chat.id, stream, joined: new Set([from]), muted: false };
    sendPayload(chat, { t: 'call-join', chat: chatRef(chat), call: id });
    connectCall(from, chat);
  };
  const box = el('div', { className: 'card' }, el('strong', { textContent: `📞 ${personName(from)} is calling${chat.kind === 'group' ? ` ${chatName(chat)}` : ''}` }),
    el('div', { className: 'row', style: 'margin-top:8px' }, btn('Answer', () => answer(true)), btn('Decline', () => answer(false), 'ghost')));
  if (!canCall()) box.append(el('p', { className: 'note', textContent: NO_MIC }));
  $('cards').prepend(box);
  const ringer = setInterval(() => navigator.vibrate?.([400, 200, 400]), 1500);
  setTimeout(() => { if (box.isConnected) { box.remove(); clearInterval(ringer); } }, 30_000);
  if (document.hidden) notify(`${personName(from)} is calling`);
}

// Exactly one side starts each connection, so two offers never cross: the smaller id adds its voice and
// offers, and the other side adds its voice in the answer (see the signal handler). The waiting side says
// "I'm here" so a newcomer to a group call knows to offer to it.
function connectCall(id, chat) {
  if (myId() < id) speakTo(peer(id));
  else sendPayload(chat, { t: 'call-here', chat: chatRef(chat), call: call.id });
  renderCall();
}

function speakTo(p) {
  if (!call || p.sender) return;
  const [track] = call.stream.getAudioTracks();
  p.sender = p.pc.addTrack(track, call.stream);
}

function hear(id, p, stream) {
  if (!p.audio) { p.audio = el('audio', { autoplay: true }); document.body.append(p.audio); }
  p.audio.srcObject = stream;
}

function leftCall(id) {
  call?.joined.delete(id);
  const p = peers.get(id);
  if (p) {
    if (p.sender) { try { p.pc.removeTrack(p.sender); } catch {} p.sender = null; }
    p.audio?.remove(); p.audio = null;
  }
  renderCall();
}

function hangUp() {
  if (!call) return;
  const chat = chats[call.chatId];
  if (chat) sendPayload(chat, { t: 'call-leave', chat: chatRef(chat), call: call.id });
  for (const id of [...peers.keys()]) leftCall(id);
  call.stream.getTracks().forEach((t) => t.stop());
  addCallNote('📞 You left the call.');
  call = null;
  renderCall();
}

function addCallNote(text) {
  const chat = call && chats[call.chatId];
  if (chat) { addMsg(chat, { system: true, text, ts: Date.now() }); renderChats(); }
}

function renderCall() {
  $('call-bar')?.remove();
  if (!call) return;
  const chat = chats[call.chatId];
  const mute = btn(call.muted ? '🔇 Unmute' : '🎙️ Mute', () => {
    call.muted = !call.muted;
    call.stream.getAudioTracks().forEach((t) => { t.enabled = !call.muted; });
    renderCall();
  }, 'ghost');
  // How each person's direct connection is doing, so a silent call shows where it stops.
  const LINK = { new: '…', connecting: 'connecting…', connected: '🟢', disconnected: 'reconnecting…', failed: '⚠️ no direct route', closed: '⚠️ no direct route' };
  const who = call.joined.size ? [...call.joined].map((id) => `${personName(id)} ${LINK[peers.get(id)?.pc.connectionState ?? 'new']}`).join(', ') : 'Calling…';
  document.body.append(el('div', { id: 'call-bar' }, el('span', { textContent: `📞 ${chat ? chatName(chat) : 'Call'} · ${who}` }), mute, btn('Hang up', hangUp)));
}
window.addEventListener('pagehide', hangUp);

// ---- Live: play a video or song from this device, or share the screen, to everyone who watches ----
// The owner adds the stream's tracks to a connection per viewer and offers; viewers only answer, so offers
// never cross. The stream id travels in the offer so the viewer can tell the show from a call.
const live = { show: null, watching: null, remote: null, element: null }; // show: { id, kind, title, stream, viewers: Set<deviceId>, source }
window.live = live;

async function startShow(kind, file) {
  if (live.show) stopShow();
  let stream, source = null, title;
  try {
    if (kind === 'screen') {
      if (!navigator.mediaDevices?.getDisplayMedia) return toast('⚠️ Screen sharing needs a laptop browser');
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      title = 'Screen';
      stream.getVideoTracks()[0].onended = () => stopShow(); // the browser's own "stop sharing" button
    } else {
      source = el(kind === 'audio' ? 'audio' : 'video', { src: URL.createObjectURL(file), controls: true, playsInline: true, style: 'width:100%;max-height:60vh;background:#000;border-radius:8px' });
      await source.play();
      stream = source.captureStream ? source.captureStream() : source.mozCaptureStream();
      title = file.name;
    }
  } catch (e) { return toast(`⚠️ Couldn't start: ${e.message}`); }
  const r = await new Promise((ok) => socket.emit('show-start', { title, kind }, ok));
  if (!r?.ok) { stream.getTracks().forEach((t) => t.stop()); return toast(`⚠️ ${r?.error}`); }
  live.show = { id: r.id, kind, title, stream, viewers: new Set(), source };
  toast(`📺 Live: ${title}. People in the room can press Watch.`);
  window.draw?.();
}

function stopShow() {
  const sh = live.show;
  if (!sh) return;
  for (const id of sh.viewers) dropViewer(id);
  sh.stream.getTracks().forEach((t) => t.stop());
  sh.source?.pause();
  socket.emit('show-stop', { id: sh.id });
  live.show = null;
  window.draw?.();
}

function dropViewer(deviceId) {
  const p = peers.get(deviceId);
  if (p?.showSenders) { for (const s of p.showSenders) { try { p.pc.removeTrack(s); } catch {} } p.showSenders = null; }
  live.show?.viewers.delete(deviceId);
}

socket.on('show-viewer', ({ id, to }) => {
  const sh = live.show;
  const dev = deviceOf(to);
  if (!sh || sh.id !== id || !dev) return;
  const p = peer(dev.id);
  p.showStream = sh.stream.id; // goes out with the offer
  p.showSenders = sh.stream.getTracks().map((t) => p.pc.addTrack(t, sh.stream));
  sh.viewers.add(dev.id);
  window.draw?.();
});
socket.on('show-left', ({ to }) => { const dev = deviceOf(to); if (dev) dropViewer(dev.id); window.draw?.(); });

async function watchShow(show) {
  if (live.watching) leaveShow();
  const r = await new Promise((ok) => socket.emit('show-watch', { id: show.id }, ok));
  if (!r?.ok) return toast(`⚠️ ${r?.error}`);
  const dev = deviceOf(show.byId);
  live.watching = { id: show.id, byId: show.byId, deviceId: dev?.id, title: show.title };
  window.draw?.();
}
function leaveShow() {
  const w = live.watching;
  if (!w) return;
  socket.emit('show-leave', { id: w.id });
  live.watching = null; live.remote = null;
  window.draw?.();
}
// Called from the signal handler: an offer that names a show stream; the matching stream arrives in ontrack.
function showStreamArrived(p, stream) {
  if (!live.watching || p.remoteShowStream !== stream.id) return false;
  live.remote = stream;
  window.draw?.();
  return true;
}
window.addEventListener('pagehide', () => { stopShow(); leaveShow(); });
