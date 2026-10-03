// WiFiRoom client glue: renders the server's shared room state with Phaser.
const S = 3;            // pixel-art scale
const T = 16 * S;       // tile size on screen
const COLS = 20, ROWS = 12, W = COLS * T, H = ROWS * T;
const DIVIDER = 10 * T; // left of this = trusted, right = unknown
const DOOR = { x: 16.5 * T, y: 0.9 * T };
const FRAMES = { self: 84, ghost: 108, people: [85, 86, 87, 88, 96, 97, 98, 99, 100, 111, 112] };
const TILES = { wall: 40, floor: 49, door: 45, chest: 89, barrel: 82 };
const BLE_ICONS = { 'AirPods': '🎧', 'Apple device': '📱', 'Find My item': '🏷️', 'AirPlay': '📺', 'Apple': '🍎', 'Named device': '🔵', 'Bluetooth device': '⚪' };
const RADAR_MAX_M = 10;
const fmtM = (m) => (m > RADAR_MAX_M ? "10 m+" : `~${m} m`); // beyond ~10 m the estimate is noise

const params = new URLSearchParams(location.search);
const socket = io({ autoConnect: false, auth: { code: params.get('code') ?? '' } });
const chars = new Map(); // id -> { sprite, label, zzz, d }
const state = { host: false, you: null, devices: new Map(), ble: { status: 'starting', list: [] }, bleAngles: {}, reactions: [], firstSync: true, selected: null };
let room, radar;

const $ = (id) => document.getElementById(id);
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const isUnknown = (d) => !d.isSelf && d.zone !== 'trusted' && !d.nickname;
const frameOf = (d) => (d.isSelf ? FRAMES.self : isUnknown(d) ? FRAMES.ghost : FRAMES.people[hash(d.id) % FRAMES.people.length]);
const nameOf = (d) => d.nickname || d.bonjourName || (d.isSelf ? 'This laptop' : d.randomMac ? 'Mystery phone?' : (d.vendor || '').replace(/<unknown>/, 'Unknown'));
const bleOf = (d) => d.bleId && state.ble.list.find((b) => b.id === d.bleId);
const myId = () => (state.host ? [...state.devices.values()].find((d) => d.isSelf)?.id : state.you);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

// ================= Room scene =================
class Room extends Phaser.Scene {
  constructor() { super('room'); }
  preload() { this.load.spritesheet('tiles', 'assets/tiles.png', { frameWidth: 16, frameHeight: 16 }); }

  create() {
    room = this;
    const tile = (f, c, r) => this.add.image(c * T, r * T, 'tiles', f).setOrigin(0).setScale(S);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) tile(r === 0 ? TILES.wall : TILES.floor, c, r);
    tile(TILES.door, 16, 0); tile(TILES.chest, 8, 1); tile(TILES.barrel, 18, 1);

    const g = this.add.graphics();
    g.fillStyle(0x6fcf97, 0.08).fillRect(T * 0.5, T * 1.6, DIVIDER - T, T * 10);
    g.fillStyle(0xeb5757, 0.08).fillRect(DIVIDER + T * 0.5, T * 1.6, DIVIDER - T, T * 10);
    g.lineStyle(2, 0x000000, 0.35).lineBetween(DIVIDER, T * 1.4, DIVIDER, H - T * 0.4);
    const zoneText = { fontFamily: 'monospace', fontSize: '16px', color: '#3a2a20' };
    this.add.text(T * 0.7, T * 1.65, 'TRUSTED', zoneText);
    this.add.text(DIVIDER + T * 0.7, T * 1.65, 'UNKNOWN · by the door', zoneText);

    // Tap the floor to walk your own character there (host walks the laptop's wizard).
    this.input.on('pointerdown', (p, over) => { if (!over.length && myId()) socket.emit('move', { x: p.worldX / T, y: p.worldY / T }); });
    this.input.on('drag', (_p, obj, x, y) => { obj.setPosition(x, y); obj.dragged = true; });
    this.input.on('dragend', (_p, obj) => { if (obj.dragged) socket.emit('place', { id: obj.deviceId, x: obj.x / T, y: obj.y / T }); });
    this.scene.launch('radar');
    socket.connect();
  }

  update() {
    for (const c of chars.values()) {
      c.label.setPosition(c.sprite.x, c.sprite.y - T * 0.6);
      c.zzz.setPosition(c.sprite.x + T * 0.35, c.sprite.y - T * 0.9);
    }
  }
}

function syncRoom(list) {
  const ids = new Set(list.map((d) => d.id));
  for (const id of chars.keys()) if (!ids.has(id)) leave(id);
  for (const d of list) d.status === 'gone' ? leave(d.id) : chars.has(d.id) ? updateChar(d) : enter(d);
  const here = list.filter((d) => d.status === 'here').length;
  const inRoom = list.reduce((n, d) => n + (d.visitors || 0), 0);
  $('count').textContent = `${here} devices${inRoom ? ` · ${inRoom} joined` : ''}`;
  if (state.selected?.type === 'device') state.devices.has(state.selected.id) ? renderPanel() : closePanel();
  state.firstSync = false;
}

function enter(d) {
  const sprite = room.add.sprite(DOOR.x, DOOR.y, 'tiles', frameOf(d)).setScale(S).setInteractive({ draggable: state.host, useHandCursor: true });
  sprite.deviceId = d.id;
  // Phaser hears pointerup on the whole window, so only treat it as a click if the press started here.
  sprite.on('pointerdown', () => { sprite.dragged = false; sprite.pressed = true; });
  sprite.on('pointerup', () => { if (sprite.pressed && !sprite.dragged) openPanel({ type: 'device', id: d.id }); sprite.pressed = false; });
  room.input.on('pointerup', () => { sprite.pressed = false; });
  const label = room.add.text(DOOR.x, DOOR.y, '', { fontFamily: 'monospace', fontSize: '13px', color: '#fff', backgroundColor: '#000a', padding: { x: 4, y: 1 } }).setOrigin(0.5, 1).setDepth(5);
  const zzz = room.add.text(0, 0, 'z', { fontFamily: 'monospace', fontSize: '16px', color: '#cfe3ff' }).setVisible(false).setDepth(5);
  room.tweens.add({ targets: zzz, alpha: 0.3, yoyo: true, repeat: -1, duration: 900 });
  // Idle "breathing" so still characters look alive without pretending to move.
  room.tweens.add({ targets: sprite, scaleY: S * 1.06, yoyo: true, repeat: -1, duration: 1200 + (hash(d.id) % 600), ease: 'Sine.easeInOut' });
  chars.set(d.id, { sprite, label, zzz, d, target: null });
  updateChar(d);
}

function updateChar(d) {
  const c = chars.get(d.id);
  c.d = d;
  c.sprite.setFrame(frameOf(d));
  const b = bleOf(d);
  c.label.setText(`${d.visitors ? '🟢 ' : ''}${nameOf(d)}${b ? ` · ${fmtM(b.meters)}` : ''}`);
  c.label.setColor(d.id === myId() ? '#f2b84b' : '#ffffff');
  const asleep = d.status === 'asleep';
  c.sprite.setAlpha(asleep ? 0.55 : 1);
  c.zzz.setVisible(asleep);
  const to = { x: d.pos.x * T, y: d.pos.y * T };
  if (!c.target || c.target.x !== to.x || c.target.y !== to.y) {
    c.target = to;
    walk(c, to);
  }
}

function leave(id) {
  const c = chars.get(id);
  if (!c) return;
  chars.delete(id);
  if (!state.firstSync) toast(`👋 ${nameOf(c.d)} left`);
  walk(c, DOOR, () => [c.sprite, c.label, c.zzz].forEach((o) => o.destroy()));
}

function walk(c, to, onComplete) {
  const dist = Phaser.Math.Distance.Between(c.sprite.x, c.sprite.y, to.x, to.y);
  const duration = Math.max(300, dist * 2.2);
  room.tweens.getTweensOf(c.sprite).filter((t) => t.data.some((td) => td.key === 'x')).forEach((t) => t.remove());
  c.sprite.setFlipX(to.x < c.sprite.x);
  room.tweens.add({ targets: c.sprite, x: to.x, y: to.y, duration, ease: 'Sine.easeInOut', onComplete });
  room.tweens.add({ targets: c.sprite, angle: { from: -7, to: 7 }, yoyo: true, repeat: Math.max(1, Math.floor(duration / 300)), duration: 150, onComplete: () => c.sprite.setAngle(0) });
}

function floatText(x, y, text, opts = {}) {
  const t = room.add.text(x, y, text, { fontFamily: 'monospace', fontSize: opts.size ?? '14px', color: '#1b1420', backgroundColor: opts.bg ?? '#fff', padding: { x: 6, y: 3 }, wordWrap: { width: 220 }, align: 'center' }).setOrigin(0.5, 1).setDepth(10);
  room.tweens.add({ targets: t, y: y - (opts.rise ?? 10), alpha: { from: 1, to: 0 }, delay: opts.hold ?? 3500, duration: 600, onComplete: () => t.destroy() });
  return t;
}

function fly(fromId, toId, glyph) {
  const a = chars.get(fromId)?.sprite, b = chars.get(toId)?.sprite;
  if (!a || !b) return;
  const t = room.add.text(a.x, a.y - T * 0.4, glyph, { fontSize: '26px' }).setOrigin(0.5).setDepth(11);
  room.tweens.add({ targets: t, x: b.x, y: b.y - T * 0.4, duration: 700, ease: 'Quad.easeInOut', onComplete: () => {
    room.tweens.add({ targets: t, scale: 1.8, alpha: 0, duration: 400, onComplete: () => t.destroy() });
  } });
}

function hop(id) {
  const s = chars.get(id)?.sprite;
  if (s) room.tweens.add({ targets: s, y: s.y - T * 0.5, yoyo: true, duration: 160, ease: 'Quad.easeOut' });
}

// ================= Radar scene =================
class Radar extends Phaser.Scene {
  constructor() { super('radar'); }
  create() {
    radar = this;
    this.blips = new Map();
    this.cx = W / 2; this.cy = H / 2 + T * 0.3; this.R = H / 2 - T * 0.8;
    this.add.rectangle(0, 0, W, H, 0x0f1a14).setOrigin(0);
    const g = this.add.graphics();
    for (const m of [1, 2, 5, 10]) {
      g.lineStyle(2, 0x2f6f4f, 0.6).strokeCircle(this.cx, this.cy, this.radius(m));
      this.add.text(this.cx + 4, this.cy - this.radius(m) - 2, `${m} m`, { fontFamily: 'monospace', fontSize: '12px', color: '#4f9f7f' }).setOrigin(0, 1);
    }
    g.lineStyle(1, 0x2f6f4f, 0.35).lineBetween(this.cx - this.R, this.cy, this.cx + this.R, this.cy).lineBetween(this.cx, this.cy - this.R, this.cx, this.cy + this.R);
    this.sweep = this.add.graphics().setDepth(1);
    this.add.sprite(this.cx, this.cy, 'tiles', FRAMES.self).setScale(S).setDepth(3);
    this.add.text(this.cx, this.cy + T * 0.6, 'you', { fontFamily: 'monospace', fontSize: '12px', color: '#9fdfbf' }).setOrigin(0.5, 0).setDepth(3);
    this.status = this.add.text(12, 12, '', { fontFamily: 'monospace', fontSize: '13px', color: '#9fdfbf', wordWrap: { width: W / 2.4 } }).setDepth(5);
    this.add.text(W - 12, 12, 'Distance: estimated from signal\nstrength, roughly ±50%.\nDirection: Bluetooth can\'t sense it.\nDrag a blip to where it really is.', { fontFamily: 'monospace', fontSize: '11px', color: '#4f9f7f', align: 'right' }).setOrigin(1, 0);
    this.input.on('drag', (_p, obj, x, y) => {
      obj.angleRad = Math.atan2(y - this.cy, x - this.cx);
      this.place(obj, false);
    });
    this.input.on('dragend', (_p, obj) => socket.emit('ble-angle', { bleId: obj.bleId, angle: obj.angleRad }));
    this.sweepAngle = 0;
    syncRadar(); // Bluetooth state may have arrived before this scene existed
    this.scene.sleep();
  }

  radius(m) { return this.R * Math.log10(1 + Math.min(m, RADAR_MAX_M)) / Math.log10(1 + RADAR_MAX_M); }

  place(b, animate = true) {
    const r = this.radius(b.meters);
    const x = this.cx + Math.cos(b.angleRad) * r, y = this.cy + Math.sin(b.angleRad) * r;
    if (animate) this.tweens.add({ targets: b, x, y, duration: 800, ease: 'Sine.easeOut' });
    else b.setPosition(x, y);
  }

  update(_t, dt) {
    this.sweepAngle = (this.sweepAngle + dt * 0.0015) % (Math.PI * 2);
    this.sweep.clear().fillStyle(0x6fcf97, 0.08).slice(this.cx, this.cy, this.R, this.sweepAngle, this.sweepAngle + 0.5).fillPath();
  }
}

function syncRadar() {
  if (!radar) return;
  const { status, list } = state.ble;
  radar.status.setText({
    'needs-permission': '🔒 Bluetooth needs permission.\nStart WiFiRoom from your own Terminal app and click "Allow" when macOS asks.',
    unavailable: '⚠️ Bluetooth is unavailable on this machine.',
    poweredOff: '⚠️ Bluetooth is turned off.',
    starting: 'Starting Bluetooth…',
    unauthorized: '🔒 Bluetooth permission was denied. Enable it in System Settings → Privacy → Bluetooth.',
  }[status] ?? `${list.length} Bluetooth devices nearby`);

  const nearest = [...list].sort((a, b) => a.meters - b.meters).slice(0, 40);
  const keep = new Set(nearest.map((b) => b.id));
  for (const [id, blip] of radar.blips) if (!keep.has(id)) { blip.destroy(); radar.blips.delete(id); }
  for (const b of nearest) {
    let blip = radar.blips.get(b.id);
    if (!blip) {
      blip = radar.add.container(radar.cx, radar.cy).setDepth(4);
      blip.icon = radar.add.text(0, 0, '', { fontSize: '22px' }).setOrigin(0.5);
      blip.name = radar.add.text(0, 16, '', { fontFamily: 'monospace', fontSize: '11px', color: '#e6fff2', backgroundColor: '#0009', padding: { x: 3, y: 1 } }).setOrigin(0.5, 0);
      blip.add([blip.icon, blip.name]);
      blip.setSize(36, 36).setInteractive({ draggable: state.host, useHandCursor: true });
      blip.on('pointerdown', () => { blip.pressed = true; });
      blip.on('pointerup', () => { if (blip.pressed && !blip.wasDragged) openPanel({ type: 'ble', id: b.id }); blip.wasDragged = blip.pressed = false; });
      blip.on('drag', () => { blip.wasDragged = true; });
      blip.bleId = b.id;
      radar.blips.set(b.id, blip);
    }
    const linked = [...state.devices.values()].find((d) => d.bleId === b.id);
    blip.meters = b.meters;
    blip.angleRad = state.bleAngles[b.id] ?? (((hash(b.id) * 137.508) % 360) * Math.PI) / 180; // golden-angle spread
    blip.icon.setText(BLE_ICONS[b.kind] ?? '⚪');
    blip.name.setText(`${linked ? nameOf(linked) : b.name || b.kind} · ${fmtM(b.meters)}`).setColor(linked ? '#f2b84b' : '#e6fff2');
    blip.setAlpha(Date.now() - b.lastSeen > 10_000 ? 0.4 : 1);
    if (!blip.input?.dragState) radar.place(blip);
  }
  if (state.selected?.type === 'ble') renderPanel();
}

// ================= Panel =================
function openPanel(sel) { state.selected = sel; renderPanel(); $('panel').classList.add('open'); }
function closePanel() { state.selected = null; $('panel').classList.remove('open'); }
$('close').onclick = closePanel;

const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
const h3 = (text) => el('h3', { textContent: text });
const btn = (text, onclick, cls = '') => el('button', { textContent: text, onclick, className: cls, type: 'button' });
const dl = (rows) => el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v ?? '—' })]));

function renderPanel() {
  const sel = state.selected;
  if (!sel) return;
  const body = $('panel-body');
  const keepFocus = document.activeElement?.dataset?.keep;
  if (keepFocus) return; // don't clobber what the host is typing
  body.replaceChildren(...(sel.type === 'device' ? devicePanel(state.devices.get(sel.id)) : blePanel(state.ble.list.find((b) => b.id === sel.id))));
}

function devicePanel(d) {
  if (!d) return [el('p', { textContent: 'Gone.' })];
  const isMe = d.id === myId();
  const out = [el('h2', { textContent: nameOf(d) }), el('div', { className: 'sub', textContent: `${d.status}${d.visitors ? ' · 🟢 in the room' : ''}${isMe ? ' · this is you' : ''}` })];

  if (!isMe && myId()) {
    out.push(h3('Interact'));
    out.push(el('div', { className: 'row' }, btn('👉 Poke', () => socket.emit('poke', { to: d.id })),
      ...(d.caps?.includes('ring') ? [btn('🔔 Ring', () => socket.emit('ring', { to: d.id }, (r) => toast(r.ok ? '🔔 Ringing…' : `⚠️ ${r.error}`)))] : []),
      ...state.reactions.map((e) => btn(e, () => socket.emit('react', { to: d.id, emoji: e }), 'emoji'))));
    const link = el('input', { placeholder: 'Paste a YouTube / Instagram / any link', type: 'url' });
    link.dataset.keep = '1';
    const send = btn('Send', () => socket.emit('share', { to: d.id, url: link.value.trim() }, (r) => {
      if (!r.ok) return toast(`⚠️ ${r.error}`);
      link.value = '';
      toast(r.delivered ? '📨 Delivered to their screen' : '📭 They haven\'t joined the room — try Share or Message below');
    }));
    out.push(h3('Send a link'), el('div', { className: 'row' }, link, send));
    const extra = [];
    if (navigator.share) extra.push(btn('📤 Share sheet (AirDrop / Nearby)', () => navigator.share({ url: link.value.trim() || undefined, text: link.value.trim() ? undefined : 'Come join my WiFiRoom!' }).catch(() => {}), 'ghost'));
    if (extra.length) out.push(el('div', { className: 'row', style: 'margin-top:6px' }, ...extra));
    if (!d.visitors) out.push(el('p', { className: 'note', textContent: 'Links pop up on their screen only after they join from the Invite QR.' }));
  }

  // Wake only makes sense for devices that aren't awake; offline ones can be woken via the MCP tools.
  const caps = (d.caps ?? []).filter((c) => c !== 'wake' || d.status !== 'here');
  if (state.host && (caps.includes('cast') || caps.includes('dlna') || caps.includes('wake'))) out.push(...controlSection(d, caps));

  if (state.host) {
    out.push(h3('Manage'));
    const nick = el('input', { value: d.nickname ?? '', placeholder: 'Nickname', maxLength: 40 });
    nick.dataset.keep = '1';
    nick.onchange = () => socket.emit('label', { id: d.id, nickname: nick.value });
    nick.onblur = () => setTimeout(renderPanel);
    out.push(nick);
    if (!d.isSelf) {
      out.push(el('div', { className: 'row', style: 'margin-top:6px' },
        btn('Mark trusted', () => socket.emit('label', { id: d.id, zone: 'trusted' })),
        btn('Send to door', () => socket.emit('label', { id: d.id, zone: 'unknown' }), 'ghost'),
        ...(!d.randomMac ? [el('a', { className: 'btn ghost', textContent: '🌐 Web page', href: `http://${d.ip}`, target: '_blank', rel: 'noopener' })] : [])));
    }
    if (state.ble.list.length) {
      const sel = el('select', {}, el('option', { value: '', textContent: '— no Bluetooth link —' }),
        ...[...state.ble.list].sort((a, b) => a.meters - b.meters).map((b) => el('option', { value: b.id, textContent: `${BLE_ICONS[b.kind] ?? ''} ${b.name || b.kind} · ${fmtM(b.meters)}`, selected: b.id === d.bleId })));
      sel.onchange = () => socket.emit('label', { id: d.id, bleId: sel.value });
      out.push(h3('Bluetooth link (shows distance)'), sel);
    }
  }

  if (state.host) out.push(h3('Details'), dl([['IP', d.ip], ['MAC', d.mac], ['Maker', d.randomMac ? 'hidden (private address)' : d.vendor], ['Bonjour', d.bonjourName], ['Zone', d.zone], ['First seen', ago(d.firstSeen)], ['Last seen', ago(d.lastSeen)], ...(bleOf(d) ? [['Distance', `${fmtM(bleOf(d).meters)} (Bluetooth)`]] : [])]));
  if (d.randomMac) out.push(el('p', { className: 'note', textContent: 'Uses a randomized Wi-Fi address (common on phones). Nickname it, or ask them to join from the Invite QR.' }));
  return out;
}

// Buttons for whatever the device's drivers support (Cast, DLNA, Wake-on-LAN).
function controlSection(d, caps) {
  const act = (action, args) => socket.emit('action', { id: d.id, action, args }, (r) => toast(r.ok ? `🎛️ ${r.message}` : `⚠️ ${r.error}`));
  const out = [h3(`Control${caps.includes('cast') ? ' · Cast' : ''}${caps.includes('dlna') ? ' · DLNA' : ''}`)];
  if (caps.includes('cast') || caps.includes('dlna')) {
    const url = el('input', { type: 'url', placeholder: caps.includes('cast') ? 'YouTube link or video/music URL' : 'Direct video or music URL' });
    url.dataset.keep = '1';
    out.push(el('div', { className: 'row' }, url, btn('▶ Play', () => url.value.trim() && act('play', { url: url.value.trim() }))));
    const vol = el('input', { type: 'range', min: 0, max: 100, value: 30, style: 'margin-top:6px' });
    vol.onchange = () => act('volume', { level: Number(vol.value) });
    out.push(el('div', { className: 'row', style: 'margin-top:6px' },
      ...(caps.includes('dlna') ? [btn('⏸', () => act('pause'), 'ghost'), btn('▶', () => act('resume'), 'ghost')] : []),
      btn('⏹ Stop', () => act('stop'), 'ghost')), vol);
  }
  if (caps.includes('wake')) out.push(el('div', { className: 'row', style: 'margin-top:6px' }, btn('⚡ Wake', () => act('wake'), 'ghost'), el('span', { className: 'note', textContent: 'Turns it on if "wake on LAN / via Wi-Fi" is enabled on the device.' })));
  return out;
}

// "Find my phone": loud beeps, vibration and a flashing screen until someone taps it.
let ringing = null;
function startRing(from) {
  stopRing();
  const overlay = el('div', { id: 'ring' }, el('div', { textContent: '🔔' }), el('p', { textContent: `${from} is looking for this phone` }), el('p', { className: 'note', textContent: 'Tap anywhere to stop' }));
  document.body.append(overlay);
  const ctx = window.__audio ?? new AudioContext();
  ctx.resume?.();
  const beep = () => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = 1320; g.gain.value = 0.4;
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.25);
    navigator.vibrate?.([300, 150, 300]);
  };
  beep();
  const timer = setInterval(beep, 700);
  ringing = { overlay, timer, end: setTimeout(stopRing, 30_000) };
  overlay.onclick = stopRing;
}
function stopRing() {
  if (!ringing) return;
  clearInterval(ringing.timer); clearTimeout(ringing.end); ringing.overlay.remove(); navigator.vibrate?.(0);
  ringing = null;
}

function blePanel(b) {
  if (!b) return [el('p', { textContent: 'Out of range.' })];
  const linked = [...state.devices.values()].find((d) => d.bleId === b.id);
  const out = [el('h2', { textContent: `${BLE_ICONS[b.kind] ?? ''} ${linked ? nameOf(linked) : b.name || b.kind}` }), el('div', { className: 'sub', textContent: `${fmtM(b.meters)} away` })];
  out.push(dl([['Type', b.kind], ['Name', b.name], ['Signal', `${b.rssi} dBm`], ['Last heard', ago(b.lastSeen)], ['Linked to', linked ? nameOf(linked) : null]]));
  if (state.host) {
    const sel = el('select', {}, el('option', { value: '', textContent: '— link to a room character —' }),
      ...[...state.devices.values()].filter((d) => !d.isSelf).map((d) => el('option', { value: d.id, textContent: nameOf(d), selected: d.bleId === b.id })));
    sel.onchange = () => {
      if (linked) socket.emit('label', { id: linked.id, bleId: '' });
      if (sel.value) socket.emit('label', { id: sel.value, bleId: b.id });
    };
    out.push(h3('Same device as…'), sel, el('p', { className: 'note', textContent: 'iPhones rotate their Bluetooth address every ~15 min, so links to phones may drop. Drag the blip on the radar to set its real direction.' }));
  }
  return out;
}

// ================= Socket events =================
socket.on('hello', (h) => {
  state.host = h.host;
  state.reactions = h.reactions;
  document.body.classList.toggle('host', h.host);
  if (h.host) {
    document.body.classList.add('in-room');
    $('qr').src = h.qr; $('code').textContent = h.code; $('join-url').textContent = h.joinUrl;
    $('lan-warn').style.display = h.lanShared ? 'none' : '';
    $('hint').textContent = 'Click a character to interact · drag to trust · tap the floor to walk · 📡 Radar shows Bluetooth devices nearby';
  } else if (!state.you) {
    $('join-code').style.display = 'none';
    $('join').classList.add('open');
    $('join-name').focus();
    $('hint').textContent = 'Tap the floor to walk · tap someone to poke, react, or send a link';
  }
});

socket.on('connect_error', (err) => {
  if (err.message !== 'bad-code') return;
  $('join').classList.add('open');
  $('join-code').style.display = '';
  $('join-err').textContent = params.get('code') ? 'That code didn\'t work.' : '';
});

$('join-form').onsubmit = (e) => {
  e.preventDefault();
  window.__audio ??= new AudioContext(); // phones only allow sound after a tap; this tap unlocks "ring"
  const code = $('join-code').value.trim();
  if ($('join-code').style.display !== 'none' && code) { socket.auth.code = code; socket.connect(); }
  socket.emit('join', { name: $('join-name').value });
};
socket.on('you', ({ id }) => { state.you = id; $('join').classList.remove('open'); document.body.classList.add('in-room'); syncRoom([...state.devices.values()]); });

socket.on('devices', (list) => { state.devices = new Map(list.map((d) => [d.id, d])); syncRoom(list); });
socket.on('ble', (b) => { state.ble = b; syncRadar(); for (const d of state.devices.values()) if (chars.has(d.id)) updateChar(d); });
socket.on('ble-angles', (a) => { state.bleAngles = a; syncRadar(); });

socket.on('arrived', ({ id, unknown }) => {
  const d = state.devices.get(id);
  const msg = `${unknown ? '👻 Unknown device' : '🚪'} ${d ? nameOf(d) : ''} walked in`;
  toast(msg);
  if (state.host && unknown) notify(msg);
});
socket.on('bubble', ({ id, text }) => { const s = chars.get(id)?.sprite; if (s) floatText(s.x, s.y - T * 0.95, text); });
socket.on('react', ({ from, to, emoji }) => fly(from, to, emoji));
socket.on('shared', ({ from, to }) => fly(from, to, '✉️'));
socket.on('poked', ({ to, alive, ms }) => {
  const s = chars.get(to)?.sprite;
  if (!s) return;
  if (alive) { hop(to); if (ms > 150) hop(to); }
  floatText(s.x, s.y - T * 0.95, alive ? `${ms > 150 ? '😓' : '⚡'} ${ms} ms` : '😴 no reply', { bg: alive ? '#bff3d3' : '#ddd', hold: 1800 });
});
socket.on('poked-you', ({ from }) => { toast(`👉 ${from} poked you!`); navigator.vibrate?.(200); });
socket.on('ring', ({ from }) => startRing(from));

socket.on('card', ({ from, url }) => {
  const u = new URL(url);
  const yt = u.hostname.includes('youtu') ? (u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop()) : null;
  const kind = yt ? '▶️ YouTube video' : u.hostname.includes('instagram') ? '📸 Instagram post' : '🔗 link';
  const card = el('div', { className: 'card' },
    el('strong', { textContent: `${from} sent you a ${kind}` }),
    el('div', { className: 'url', textContent: url }),
    el('div', { className: 'row' }, el('a', { className: 'btn', textContent: 'Open', href: url, target: '_blank', rel: 'noopener noreferrer' }), btn('Dismiss', () => card.remove(), 'ghost')));
  $('cards').prepend(card);
  navigator.vibrate?.([100, 60, 100]);
  if (document.hidden) notify(`${from} sent you a ${kind}`);
});


// ================= UI wiring =================
$('chat').onsubmit = (e) => { e.preventDefault(); socket.emit('say', $('chat-text').value); $('chat-text').value = ''; };
$('open-invite').onclick = () => $('invite').classList.add('open');
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('.modal').classList.remove('open')));
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
  const toRadar = t.dataset.view === 'radar';
  closePanel();
  if (toRadar) { room.scene.sleep('room'); room.scene.wake('radar'); } else { room.scene.sleep('radar'); room.scene.wake('room'); }
}));
$('open-timeline').onclick = () => socket.emit('timeline', (events) => {
  $('timeline-list').replaceChildren(...(events.length ? events.map((ev) => el('li', {}, el('time', { textContent: new Date(ev.t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }), el('span', { textContent: `${ev.name} ${ev.type}` }))) : [el('li', { textContent: 'Nothing yet — arrivals and departures will show up here.' })]));
  $('timeline').classList.add('open');
});
$('alerts').onclick = async () => {
  const p = await Notification.requestPermission();
  $('alerts').textContent = p === 'granted' ? '🔔 Alerts on' : '🔕 Alerts blocked';
};
function notify(body) { if (window.Notification?.permission === 'granted') new Notification('WiFiRoom', { body, icon: 'assets/tiles.png' }); }

function toast(msg) {
  const t = el('div', { className: 'toast', textContent: msg });
  $('toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

new Phaser.Game({
  type: Phaser.AUTO, parent: 'room', width: W, height: H, pixelArt: true, backgroundColor: '#1b1420', scene: [Room, Radar],
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_HORIZONTALLY },
});
