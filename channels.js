// Channels: conversations kept on the device hosting the room, so people who arrive late see what was said
// and reopening the app shows the same conversations. #general is for everyone; public channels anyone can
// join; private rooms have invited members. Direct messages are not here: they stay end-to-end encrypted
// between browsers (chat.js), unreadable by the host.
//
// People are known by a stable id derived from the public key their browser already keeps for chats, so
// the same person is the same person on a reload, a new Wi-Fi address, or another day.
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { JSONFilePreset } from 'lowdb/node';

const MAX_MESSAGES = 2000;  // kept per channel; older ones fall off
const PAGE = 80;            // messages sent per history request
const MAX_TEXT = 4000;

export const idOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 12);
const isKey = (k) => typeof k === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(k);
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// Channel names look like Slack's: lowercase, digits, dashes.
const slug = (s) => clean(s, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

// Device linking: the new device shows a code; the old device seals its identity key under a key derived from
// that code and leaves the sealed blob here under a token also derived from the code. This never sees the key.
const links = new Map(); // token -> { box, nonce, at }
const LINK_TTL = 2 * 60_000;
const isB64 = (s, max) => typeof s === 'string' && s.length <= max && /^[A-Za-z0-9+/=]+$/.test(s);

export async function startChannels({ dataDir, io }) {
  const db = await JSONFilePreset(path.join(dataDir, 'channels.json'), { users: {}, channels: {}, messages: {}, locked: false });
  const { users, channels, messages } = db.data;
  db.data.locked ??= false;
  if (!channels.general) {
    channels.general = { id: 'general', name: 'general', kind: 'public', topic: 'Everyone on this Wi-Fi', members: [], created: Date.now(), by: null };
    messages.general = [];
  }
  if (!channels.announcements) {
    channels.announcements = { id: 'announcements', name: 'announcements', kind: 'public', topic: 'From the host', members: [], created: Date.now(), by: null, hostOnly: true };
    messages.announcements = [];
  }
  let dirty = null;
  const save = () => { dirty ??= setTimeout(() => { dirty = null; db.write().catch(() => {}); }, 500); };

  const canSee = (ch, uid) => ch.kind === 'public' || ch.members.includes(uid);
  const EVERYONE = ['general', 'announcements']; // joined automatically
  const isMember = (ch, uid) => EVERYONE.includes(ch.id) || ch.members.includes(uid);
  const view = (ch, uid) => ({ id: ch.id, name: ch.name, kind: ch.kind, topic: ch.topic, members: EVERYONE.includes(ch.id) ? Object.keys(users) : ch.members, joined: isMember(ch, uid), by: ch.by, last: messages[ch.id]?.at(-1)?.ts ?? ch.created, host: ch.hostOnly ?? false });
  const listFor = (uid) => Object.values(channels).filter((ch) => canSee(ch, uid)).map((ch) => view(ch, uid));
  const room = (cid) => `ch:${cid}`;
  const peopleView = () => Object.fromEntries(Object.entries(users).map(([id, u]) => [id, { name: u.name, seen: u.seen, online: online.has(id), host: !!u.host, tag: id.slice(0, 4), banned: !!u.banned }]));
  const online = new Map(); // uid -> count of open pages

  // Everyone's channel list and the people list, after anything that changes them.
  const listeners = [];
  const announce = () => {
    for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('channels', { list: listFor(s.data.uid), people: peopleView(), locked: db.data.locked });
    for (const f of listeners) f();
  };

  function attach(socket, { isHost }) {
    // Who this page is. The host's page is a person too (the organizer).
    socket.on('identify', ({ key, name } = {}, ack) => {
      if (!isKey(key)) return ack?.({ ok: false, error: 'bad key' });
      const uid = idOf(key);
      // Host powers: someone the host removed stays out until let back; a locked room takes nobody new.
      if (users[uid]?.banned) { ack?.({ ok: false, error: 'The host removed you from this room', banned: true }); return socket.disconnect(true); }
      if (db.data.locked && !users[uid] && !isHost) return ack?.({ ok: false, error: 'The host has locked this room; nobody new can join right now', locked: true });
      const u = (users[uid] ??= { name: '', key, seen: 0, host: false });
      const cleanName = clean(name, 40);
      // One name per person in this room, so nobody can pass for someone else.
      const taken = cleanName && Object.entries(users).find(([id, x]) => id !== uid && x.name.toLowerCase() === cleanName.toLowerCase());
      if (taken) return ack?.({ ok: false, error: `"${cleanName}" is already someone here; pick another name (your own code: #${uid.slice(0, 4)})`, taken: true });
      if (cleanName && !taken) u.name = cleanName;
      if (!u.name) return ack?.({ ok: false, error: 'Pick a name first' });
      u.seen = Date.now();
      if (isHost) u.host = true;
      if (socket.data.uid && socket.data.uid !== uid) leaveAll();
      socket.data.uid = uid;
      online.set(uid, (online.get(uid) ?? 0) + 1);
      for (const ch of Object.values(channels)) if (isMember(ch, uid)) socket.join(room(ch.id));
      save();
      ack?.({ ok: true, uid, host: u.host });
      announce();
    });

    const leaveAll = () => {
      const uid = socket.data.uid;
      if (!uid) return;
      const n = (online.get(uid) ?? 1) - 1;
      n > 0 ? online.set(uid, n) : online.delete(uid);
      if (users[uid]) users[uid].seen = Date.now();
      socket.data.uid = null;
    };
    socket.on('disconnect', () => { leaveAll(); save(); announce(); });

    const me = () => socket.data.uid && users[socket.data.uid] ? socket.data.uid : null;

    // ---- host powers ----
    socket.on('person-kick', ({ who } = {}, ack) => {
      const h = me();
      if (!h || !users[h]?.host || !users[who] || users[who].host) return ack?.({ ok: false, error: 'Not allowed' });
      users[who].banned = true;
      for (const s of io.sockets.sockets.values()) if (s.data.uid === who) { s.emit('removed'); s.disconnect(true); }
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('person-unban', ({ who } = {}, ack) => {
      const h = me();
      if (!h || !users[h]?.host || !users[who]) return ack?.({ ok: false, error: 'Not allowed' });
      delete users[who].banned;
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('room-lock', ({ locked } = {}, ack) => {
      const h = me();
      if (!h || !users[h]?.host) return ack?.({ ok: false, error: 'Not allowed' });
      db.data.locked = !!locked;
      save(); ack?.({ ok: true }); announce();
    });

    // ---- device linking (see the note at the top) ----
    socket.on('link-offer', ({ token, box, nonce } = {}, ack) => {
      if (!me() || !isB64(token, 32) || !isB64(box, 4000) || !isB64(nonce, 40)) return ack?.({ ok: false, error: 'bad link' });
      for (const [t, l] of links) if (Date.now() - l.at > LINK_TTL) links.delete(t);
      if (links.size > 100) return ack?.({ ok: false, error: 'Too many links waiting; try again in a minute' });
      links.set(token, { box, nonce, at: Date.now() });
      ack?.({ ok: true });
    });
    let claims = { at: 0, n: 0 };
    socket.on('link-claim', ({ token } = {}, ack) => {
      const now = Date.now();
      if (now - claims.at > 60_000) claims = { at: now, n: 0 };
      if (++claims.n > 40) return ack?.({ ok: false, error: 'Slow down' }); // polling every 2 s plus a few guesses, nothing more
      const l = isB64(token, 32) ? links.get(token) : null;
      if (!l || now - l.at > LINK_TTL) return ack?.({ ok: false, waiting: true });
      links.delete(token); // single use
      ack?.({ ok: true, box: l.box, nonce: l.nonce });
    });
    const chan = (cid) => (typeof cid === 'string' ? channels[cid] : undefined);

    socket.on('channel-create', ({ name, kind, members, topic, hostOnly } = {}, ack) => {
      const uid = me();
      if (!uid) return ack?.({ ok: false, error: 'Join the room first' });
      const id = slug(name);
      if (!id) return ack?.({ ok: false, error: 'Give the channel a name' });
      if (channels[id]) return ack?.({ ok: false, error: `#${id} already exists` });
      const priv = kind === 'private';
      const picked = (Array.isArray(members) ? members : []).filter((m) => typeof m === 'string' && users[m] && m !== uid).slice(0, 200);
      channels[id] = { id, name: id, kind: priv ? 'private' : 'public', topic: clean(topic, 120), members: [uid, ...picked], created: Date.now(), by: uid, hostOnly: !!hostOnly && !!users[uid].host };
      messages[id] = [{ id: randomBytes(6).toString('hex'), system: true, text: `${users[uid].name} created ${priv ? 'this private room' : 'this channel'}.`, ts: Date.now() }];
      for (const s of io.sockets.sockets.values()) if (s.data.uid && channels[id].members.includes(s.data.uid)) s.join(room(id));
      save();
      ack?.({ ok: true, id });
      announce();
    });

    socket.on('channel-join', ({ id } = {}, ack) => {
      const uid = me(), ch = chan(id);
      if (!uid || !ch || !canSee(ch, uid)) return ack?.({ ok: false, error: 'No such channel' });
      if (!ch.members.includes(uid)) {
        ch.members.push(uid);
        post(ch, { system: true, text: `${users[uid].name} joined.` });
      }
      socket.join(room(id));
      save();
      ack?.({ ok: true });
      announce();
    });

    socket.on('channel-leave', ({ id } = {}, ack) => {
      const uid = me(), ch = chan(id);
      if (!uid || !ch || EVERYONE.includes(ch.id)) return ack?.({ ok: false, error: "Can't leave this one" });
      ch.members = ch.members.filter((m) => m !== uid);
      socket.leave(room(id));
      post(ch, { system: true, text: `${users[uid].name} left.` });
      if (!ch.members.length) { delete channels[id]; delete messages[id]; }
      save();
      ack?.({ ok: true });
      announce();
    });

    // Add someone to a channel you're in (private rooms grow this way).
    socket.on('channel-invite', ({ id, who } = {}, ack) => {
      const uid = me(), ch = chan(id);
      if (!uid || !ch || !isMember(ch, uid) || !users[who]) return ack?.({ ok: false, error: 'Not allowed' });
      if (!ch.members.includes(who)) {
        ch.members.push(who);
        for (const s of io.sockets.sockets.values()) if (s.data.uid === who) s.join(room(id));
        post(ch, { system: true, text: `${users[uid].name} added ${users[who].name}.` });
      }
      save();
      ack?.({ ok: true });
      announce();
    });

    socket.on('channel-send', ({ id, text } = {}, ack) => {
      const uid = me(), ch = chan(id);
      if (!uid || !ch || !isMember(ch, uid)) return ack?.({ ok: false, error: 'Join the channel first' });
      if (ch.hostOnly && !users[uid].host) return ack?.({ ok: false, error: 'Only the host posts here' });
      const body = String(text ?? '').trim().slice(0, MAX_TEXT);
      if (!body) return ack?.({ ok: false, error: 'Empty' });
      const m = post(ch, { from: uid, text: body });
      ack?.({ ok: true, id: m.id });
    });

    // Older messages, newest page first; `before` is a message timestamp.
    socket.on('channel-history', ({ id, before } = {}, ack) => {
      const uid = me(), ch = chan(id);
      if (!uid || !ch || !canSee(ch, uid)) return ack?.({ ok: false, error: 'No such channel' });
      const all = messages[ch.id] ?? [];
      const cut = typeof before === 'number' ? all.filter((m) => m.ts < before) : all;
      ack?.({ ok: true, messages: cut.slice(-PAGE), more: cut.length > PAGE });
    });

    socket.on('channel-topic', ({ id, topic } = {}, ack) => {
      const uid = me(), ch = chan(id);
      if (!uid || !ch || !isMember(ch, uid)) return ack?.({ ok: false, error: 'Not allowed' });
      ch.topic = clean(topic, 120);
      save();
      ack?.({ ok: true });
      announce();
    });
  }

  function post(ch, m) {
    const msg = { id: randomBytes(6).toString('hex'), ts: Date.now(), ...m };
    const list = (messages[ch.id] ??= []);
    list.push(msg);
    if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
    io.to(room(ch.id)).emit('channel-msg', { channel: ch.id, message: msg });
    save();
    return msg;
  }

  return {
    attach,
    isHost: (uid) => !!users[uid]?.host,
    nameOf: (uid) => users[uid]?.name ?? 'Someone',
    onChange: (f) => listeners.push(f), // runs after anyone identifies, joins or leaves
    // For the room itself (server.js): a removed person can't walk in as a character either, nor anyone new while locked.
    admits: (key) => { if (!isKey(key)) return { ok: true }; const uid = idOf(key); if (users[uid]?.banned) return { ok: false, error: 'The host removed you from this room' }; if (db.data.locked && !users[uid]) return { ok: false, error: 'The host has locked this room' }; return { ok: true }; },
  };
}
