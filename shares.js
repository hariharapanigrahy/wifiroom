// Shares: folders people allow from their own devices. Nothing is copied here. The room keeps only the
// listing (names, sizes) of each share while its owner's page is connected, and passes download requests to
// the owner's device, which sends the file straight to whoever asked (see p2p.js). Stopping a share removes
// it for everyone at once; with the owner's page gone, the share goes too.
const clean = (s, max) => String(s ?? '').replace(/[\x00-\x1f]/g, '').trim().slice(0, max);
const MAX_FILES = 2000;
const kindOf = (mime, name) => (/^image\//.test(mime) ? 'image' : /^video\//.test(mime) || /\.(mkv|mp4|webm|mov)$/i.test(name) ? 'video' : /^audio\//.test(mime) || /\.(mp3|m4a|flac|ogg|wav)$/i.test(name) ? 'audio' : 'file');

// Live shows: a person plays a video or a song from their device, or shares their screen, and everyone who
// presses Watch gets the picture and sound streamed straight from that device (WebRTC, see p2p.js). The room
// keeps only the list of what's live and introduces each viewer to the owner.
export function startShares({ io, isHost, nameOf }) {
  const shares = new Map(); // id -> { id, by, socket, name, files, audience: 'all' | Set<uid>, ts, sent: [{to, path, ts}] }
  const shows = new Map();  // id -> { id, by, socket, title, kind, ts, viewers: Set<uid> }
  let next = 1;

  const canSee = (sh, uid) => sh.by === uid || sh.audience === 'all' || sh.audience.has(uid);
  const view = (sh, uid) => ({ id: sh.id, by: nameOf(sh.by), byId: sh.by, mine: sh.by === uid, name: sh.name, files: sh.files, ts: sh.ts,
    audience: sh.audience === 'all' ? 'all' : [...sh.audience].map(nameOf), ...(sh.by === uid && { sent: sh.sent.slice(-50).map((s) => ({ ...s, to: nameOf(s.to) })) }) });
  const snapshot = (uid) => ({
    shares: [...shares.values()].filter((sh) => canSee(sh, uid)).map((sh) => view(sh, uid)).sort((a, b) => b.ts - a.ts),
    shows: [...shows.values()].map((s) => ({ id: s.id, by: nameOf(s.by), byId: s.by, mine: s.by === uid, title: s.title, kind: s.kind, ts: s.ts, viewers: s.viewers.size, watching: s.viewers.has(uid) })),
  });
  const announce = () => { for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('shares', snapshot(s.data.uid)); };

  function attach(socket) {
    const uid = () => socket.data.uid;

    socket.on('share-start', ({ name, files, audience } = {}, ack) => {
      if (!uid()) return ack?.({ ok: false, error: 'Pick a name first' });
      const list = (Array.isArray(files) ? files : []).slice(0, MAX_FILES).map((f) => ({ path: clean(f?.path, 400), size: Math.max(0, Number(f?.size) || 0), mime: clean(f?.mime, 80), kind: kindOf(String(f?.mime ?? ''), String(f?.path ?? '')) })).filter((f) => f.path);
      if (!list.length) return ack?.({ ok: false, error: 'That folder is empty' });
      const sh = { id: `s${next++}`, by: uid(), socket: socket.id, name: clean(name, 80) || 'Shared folder', files: list, audience: Array.isArray(audience) ? new Set(audience.filter((a) => typeof a === 'string')) : 'all', ts: Date.now(), sent: [] };
      shares.set(sh.id, sh);
      ack?.({ ok: true, id: sh.id }); announce();
    });

    socket.on('share-stop', ({ id } = {}, ack) => {
      const sh = shares.get(id);
      if (!sh || !(sh.by === uid() || isHost(uid()))) return ack?.({ ok: false, error: 'Not your share' });
      shares.delete(id);
      ack?.({ ok: true }); announce();
    });

    // Who may see it: everyone, or picked people.
    socket.on('share-audience', ({ id, audience } = {}, ack) => {
      const sh = shares.get(id);
      if (!sh || sh.by !== uid()) return ack?.({ ok: false, error: 'Not your share' });
      sh.audience = Array.isArray(audience) ? new Set(audience.filter((a) => typeof a === 'string')) : 'all';
      ack?.({ ok: true }); announce();
    });

    // "Send me this file": passed to the owner's page, which sends it device to device.
    socket.on('share-get', ({ id, path } = {}, ack) => {
      const sh = shares.get(id), me = uid();
      if (!sh || !me || !canSee(sh, me)) return ack?.({ ok: false, error: 'That share is gone' });
      if (sh.by === me) return ack?.({ ok: false, error: "It's your own folder" });
      const f = sh.files.find((x) => x.path === path);
      if (!f) return ack?.({ ok: false, error: 'No such file in the share' });
      const owner = io.sockets.sockets.get(sh.socket);
      if (!owner) { shares.delete(id); announce(); return ack?.({ ok: false, error: 'The owner has left' }); }
      sh.sent.push({ to: me, path, ts: Date.now() });
      owner.emit('share-serve', { id, path, to: me, toName: nameOf(me) });
      ack?.({ ok: true });
      announce();
    });

    // ---- live shows ----
    socket.on('show-start', ({ title, kind } = {}, ack) => {
      if (!uid()) return ack?.({ ok: false, error: 'Pick a name first' });
      for (const [id, s] of shows) if (s.by === uid()) shows.delete(id); // one show per person
      const s = { id: `v${next++}`, by: uid(), socket: socket.id, title: clean(title, 80) || 'Live', kind: ['screen', 'video', 'audio'].includes(kind) ? kind : 'video', ts: Date.now(), viewers: new Set() };
      shows.set(s.id, s);
      ack?.({ ok: true, id: s.id }); announce();
    });
    socket.on('show-stop', ({ id } = {}, ack) => {
      const s = shows.get(id);
      if (!s || !(s.by === uid() || isHost(uid()))) return ack?.({ ok: false, error: 'Not your show' });
      shows.delete(id);
      ack?.({ ok: true }); announce();
    });
    socket.on('show-watch', ({ id } = {}, ack) => {
      const s = shows.get(id), me = uid();
      if (!s || !me) return ack?.({ ok: false, error: 'That show is over' });
      if (s.by === me) return ack?.({ ok: false, error: "It's your own show" });
      const owner = io.sockets.sockets.get(s.socket);
      if (!owner) { shows.delete(id); announce(); return ack?.({ ok: false, error: 'The show is over' }); }
      s.viewers.add(me);
      owner.emit('show-viewer', { id, to: me, toName: nameOf(me) });
      ack?.({ ok: true, byId: s.by }); announce();
    });
    socket.on('show-leave', ({ id } = {}, ack) => {
      const s = shows.get(id);
      if (s && uid()) { s.viewers.delete(uid()); io.sockets.sockets.get(s.socket)?.emit('show-left', { id, to: uid() }); announce(); }
      ack?.({ ok: true });
    });

    socket.on('shares-get', (...args) => { const ack = args.find((a) => typeof a === 'function'); if (uid()) ack?.(snapshot(uid())); });
    socket.on('disconnect', () => {
      let gone = false;
      for (const [id, sh] of shares) if (sh.socket === socket.id) { shares.delete(id); gone = true; }
      for (const [id, s] of shows) {
        if (s.socket === socket.id) { shows.delete(id); gone = true; }
        else if (socket.data.uid && s.viewers.delete(socket.data.uid)) { io.sockets.sockets.get(s.socket)?.emit('show-left', { id, to: socket.data.uid }); gone = true; }
      }
      if (gone) announce();
    });
  }

  return { attach, announce };
}
