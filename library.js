// Files: a shared library on the device hosting the room. Anyone in the room uploads; everyone browses,
// downloads, and plays music, video and images in place. Nothing here checks what a file is: anything that
// isn't an image, audio or video is served as a download, never opened by the app, and the page says so. Files live in <data>/library/, with their details in
// library.json. Uploads stream straight to disk (PUT with the file as the body), and downloads are served with
// range support, so a video seeks without downloading first.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { JSONFilePreset } from 'lowdb/node';

const MAX_FILE = 8 * 1024 ** 3; // 8 GB
const id = () => randomBytes(6).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/[\\/\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, max);
const kindOf = (mime, name) => (/^image\//.test(mime) ? 'image' : /^video\//.test(mime) || /\.(mkv|mp4|webm|mov)$/i.test(name) ? 'video' : /^audio\//.test(mime) || /\.(mp3|m4a|flac|ogg|wav)$/i.test(name) ? 'audio' : 'file');

export async function startLibrary({ dataDir, app, io, isHost, nameOf, idOf }) {
  const dir = path.join(dataDir, 'library');
  fs.mkdirSync(dir, { recursive: true });
  const db = await JSONFilePreset(path.join(dataDir, 'library.json'), { files: [], folders: [] });
  const L = db.data;
  let dirty = null;
  const save = () => { dirty ??= setTimeout(() => { dirty = null; db.write().catch(() => {}); }, 500); };
  const diskPath = (f) => path.join(dir, `${f.id}${path.extname(f.name).slice(0, 10)}`);

  const snapshot = (uid) => ({
    files: L.files.map((f) => ({ ...f, by: nameOf(f.by), mine: f.by === uid || isHost(uid), url: `/library/${f.id}/${encodeURIComponent(f.name)}` })).sort((a, b) => b.ts - a.ts),
    free: (() => { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; } })(),
  });
  const announce = () => { for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('library', snapshot(s.data.uid)); };

  // Who is uploading: the browser sends its chat public key, the same thing it identifies to channels with.
  const uidFrom = (req) => { const key = req.get('x-wifiroom-key'); return key && /^[A-Za-z0-9+/]{43}=$/.test(key) ? idOf(key) : null; };

  app.put('/api/library/upload', (req, res) => {
    const uid = uidFrom(req);
    if (!uid) return res.status(401).json({ ok: false, error: 'Pick a name first' });
    const name = clean(decodeURIComponent(req.query.name ?? ''), 200) || 'file';
    const size = Number(req.get('content-length')) || 0;
    if (size > MAX_FILE) return res.status(413).json({ ok: false, error: 'Too big (8 GB max)' });
    const folder = clean(req.query.folder ?? '', 40);
    const f = { id: id(), name, size, mime: (req.get('content-type') || 'application/octet-stream').split(';')[0], by: uid, ts: Date.now(), folder, kind: kindOf(req.get('content-type') || '', name) };
    const out = fs.createWriteStream(diskPath(f));
    let got = 0;
    req.on('data', (c) => { got += c.length; });
    req.pipe(out);
    out.on('finish', () => {
      if (size && got !== size) { fs.rm(diskPath(f), () => {}); return res.status(400).json({ ok: false, error: 'Upload was cut short' }); }
      f.size = got;
      L.files.push(f);
      save();
      res.json({ ok: true, id: f.id });
      announce();
    });
    out.on('error', () => res.status(500).json({ ok: false, error: 'Could not save the file' }));
    req.on('aborted', () => { out.destroy(); fs.rm(diskPath(f), () => {}); });
  });

  // Streams with range requests (sendFile handles them), inline for media so the browser plays it, download otherwise.
  app.get('/library/:id{/:name}', (req, res) => {
    const f = L.files.find((x) => x.id === req.params.id);
    if (!f) return res.status(404).send('No such file');
    res.setHeader('Content-Disposition', `${req.query.download !== undefined || f.kind === 'file' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    // dotfiles: the data folder is ~/.wifiroom, which sendFile would otherwise treat as hidden.
    res.sendFile(diskPath(f), { headers: { 'Content-Type': f.mime }, acceptRanges: true, cacheControl: false, dotfiles: 'allow' }, (err) => { if (err && !res.headersSent) res.status(404).send('Gone'); });
  });

  function attach(socket) {
    const uid = () => socket.data.uid;
    socket.on('library-get', (...args) => { const ack = args.find((a) => typeof a === 'function'); if (uid()) ack?.(snapshot(uid())); });
    socket.on('library-delete', ({ id: fid } = {}, ack) => {
      const f = L.files.find((x) => x.id === fid);
      if (!f || !uid() || !(f.by === uid() || isHost(uid()))) return ack?.({ ok: false, error: 'Only whoever uploaded it, or the host, can remove it' });
      L.files = L.files.filter((x) => x !== f);
      fs.rm(diskPath(f), () => {});
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('library-rename', ({ id: fid, name, folder } = {}, ack) => {
      const f = L.files.find((x) => x.id === fid);
      if (!f || !uid() || !(f.by === uid() || isHost(uid()))) return ack?.({ ok: false, error: 'Not yours to change' });
      if (name !== undefined) f.name = clean(name, 200) || f.name;
      if (folder !== undefined) f.folder = clean(folder, 40);
      save(); ack?.({ ok: true }); announce();
    });
  }

  return { attach, announce };
}
