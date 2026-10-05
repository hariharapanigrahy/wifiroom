// Channels and private rooms, kept on the device hosting the room (see channels.js on the server). This
// adds a channel list to the Chats screen and a channel view; direct messages stay in chat.js.
const ch = window.ch = { list: [], people: {}, me: null, host: false, msgs: {}, more: {}, unread: {}, open: null, draft: {} };
const myName = () => load('wifiroom.myName', '') || state.name || '';
const nameOfUid = (uid) => (uid === ch.me ? 'You' : ch.people[uid]?.name ?? 'Someone');
const byId = (id) => ch.list.find((c) => c.id === id);
const isPublic = (c) => c.kind === 'public';

// Tell the host who this page is, once it has a name. Called on every (re)connect.
function identify() {
  const name = myName();
  if (!name) return;
  socket.emit('identify', { key: myChatKey(), name }, (r) => {
    if (r?.ok) { ch.me = r.uid; ch.host = r.host; ch.nameError = null; }
    else if (r?.taken) { ch.nameError = r.error; save('wifiroom.myName', ''); toast(`⚠️ ${r.error}`); }
    else if (r?.locked || r?.banned) { ch.nameError = r.error; toast(`⚠️ ${r.error}`); }
    renderChats();
  });
}
const nameTag = (uid) => `#${String(uid).slice(0, 4)}`; // a fingerprint of the key, shown next to names; it can't be chosen

// ---- Linking a device: move this identity (its key) to another device. The new device shows a 12-character
// code; on the old device you type it. The key travels sealed under a key derived from the code, via the room,
// which only sees an opaque blob under a token also derived from the code. ----
const linkKeys = (code) => {
  const norm = code.toUpperCase().replace(/[^A-Z2-9]/g, '');
  const h = nacl.hash(new TextEncoder().encode(`wifiroom-link:${norm}`));
  return { key: h.slice(0, 32), token: toB64(nacl.hash(new TextEncoder().encode(`wifiroom-token:${norm}`)).slice(0, 16)) };
};
const newLinkCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = nacl.randomBytes(12); return [...b].map((x) => A[x % 32]).join('').replace(/(.{4})(?=.)/g, '$1-'); };
const link = { code: null, timer: null, done: false };
// New device: show a code and wait for the old device to send the sealed key.
function startLinkWait() {
  link.code = newLinkCode(); link.done = false;
  const { key, token } = linkKeys(link.code);
  const started = Date.now();
  clearInterval(link.timer);
  link.timer = setInterval(() => {
    if (Date.now() - started > 2 * 60_000) { clearInterval(link.timer); link.code = null; renderChats(); return; }
    socket.emit('link-claim', { token }, (r) => {
      if (!r?.ok) return;
      clearInterval(link.timer);
      const plain = nacl.secretbox.open(fromB64(r.box), fromB64(r.nonce), key);
      if (!plain) { toast('⚠️ That link didn\'t check out'); link.code = null; renderChats(); return; }
      const { secret, name } = JSON.parse(new TextDecoder().decode(plain));
      save('wifiroom.chatSecret', secret); save('wifiroom.myName', name);
      localStorage.removeItem('wifiroom.chats'); localStorage.removeItem('wifiroom.chatPins'); // private chats don't move; they stay on the old device
      link.done = true; renderChats();
      toast(`✅ This device is now ${name}`);
      setTimeout(() => location.reload(), 1200);
    });
  }, 2000);
  renderChats();
}
// Old device: seal this identity for the device showing `code`.
function offerLink(code) {
  if (code.replace(/[^A-Za-z2-9]/g, '').length !== 12) return toast('The code is 12 characters');
  const { key, token } = linkKeys(code);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plain = new TextEncoder().encode(JSON.stringify({ secret: toB64(chatKeyPair.secretKey), name: myName() }));
  socket.emit('link-offer', { token, nonce: toB64(nonce), box: toB64(nacl.secretbox(plain, nonce, key)) }, (r) => toast(r?.ok ? '📲 Sent. The other device picks it up within a few seconds.' : `⚠️ ${r?.error}`));
}
window.wifiroomLink = { startLinkWait, offerLink, linkKeys, newLinkCode, link };
socket.on('hello', () => setTimeout(identify, 100)); // after chat.js has registered the key
socket.on('you', identify);
// Unread counts come from the host (per person, so they survive a reload); `read` is sent when a channel is open.
socket.on('channels', ({ list, people, locked }) => { ch.list = list; ch.people = people; ch.locked = !!locked; for (const c of list) ch.unread[c.id] = c.unread ?? 0; renderChats(); });
const channelOpen = (id) => view.screen === 'channel' && view.chatId === id && $('chats').classList.contains('open') && !document.hidden;
const markRead = (id) => { const last = ch.msgs[id]?.at(-1); if (last) socket.emit('channel-read', { id, ts: last.ts }); };
socket.on('channel-msg', ({ channel, message }) => {
  (ch.msgs[channel] ??= []).push(message);
  if (channelOpen(channel)) markRead(channel);
  else if (message.from !== ch.me) {
    ch.unread[channel] = (ch.unread[channel] ?? 0) + 1;
    if (!message.system && !message.mentions?.includes(ch.me)) { toast(`#${channel} · ${nameOfUid(message.from)}: ${message.text.slice(0, 60)}`); if (document.hidden) notify(`#${channel}: ${nameOfUid(message.from)}`); }
  }
  renderChats();
});
socket.on('channel-msg-update', ({ channel, message }) => {
  const list = ch.msgs[channel]; if (!list) return;
  const i = list.findIndex((m) => m.id === message.id); if (i >= 0) list[i] = message;
  renderChats();
});
socket.on('channel-mention', ({ channel, by, text }) => {
  toast(`@ ${by} mentioned you in #${channel}: ${text.slice(0, 60)}`); navigator.vibrate?.([80, 40, 80]);
  if (document.hidden || !channelOpen(channel)) notify(`${by} mentioned you in #${channel}`);
});
const typing = {}; // channel -> { name -> until }
socket.on('channel-typing', ({ channel, uid, name }) => {
  (typing[channel] ??= {})[name] = Date.now() + 3000;
  if (channelOpen(channel)) renderTyping(channel);
  setTimeout(() => channelOpen(channel) && renderTyping(channel), 3100);
});
function renderTyping(id) {
  const now = Date.now(), who = Object.entries(typing[id] ?? {}).filter(([, t]) => t > now).map(([n]) => n);
  let bar = $('chats-typing'); if (!bar) { bar = el('div', { id: 'chats-typing', className: 'note', style: 'padding:0 14px 4px;min-height:16px' }); $('chats-form').before(bar); }
  bar.textContent = who.length ? `${who.join(', ')} ${who.length > 1 ? 'are' : 'is'} typing…` : '';
}
window.addEventListener('focus', () => { if (view.screen === 'channel' && view.chatId) markRead(view.chatId); });
const REACT = ['👍', '❤️', '😂', '🔥', '👀', '🎉'];
const channelUnread = () => Object.values(ch.unread).reduce((a, b) => a + b, 0);

function openChannel(id) {
  const c = byId(id);
  if (!c) return;
  if (!c.joined) return socket.emit('channel-join', { id }, (r) => (r.ok ? openChannel(id) : toast(`⚠️ ${r.error}`)));
  view.screen = 'channel'; view.chatId = id;
  ch.openedAt = ch.unread[id] ? (c.lastRead ?? 0) : 0; // where the "new messages" line goes
  ch.unread[id] = 0;
  showPane('chats');
  if (!ch.msgs[id]) socket.emit('channel-history', { id }, (r) => { if (r.ok) { ch.msgs[id] = r.messages; ch.more[id] = r.more; renderChats(); markRead(id); } });
  else markRead(id);
  renderChats();
  $('chats-text').focus();
}

function loadOlder(id) {
  const first = ch.msgs[id]?.[0];
  socket.emit('channel-history', { id, before: first?.ts }, (r) => { if (r.ok) { ch.msgs[id] = [...r.messages, ...ch.msgs[id]]; ch.more[id] = r.more; renderChats(); } });
}

function sendToChannel(id, text) {
  if (!text.trim()) return;
  socket.emit('channel-send', { id, text }, (r) => { if (!r.ok) toast(`⚠️ ${r.error}`); });
}

// ---- the list screen's channel section ----
function channelSection() {
  if (!ch.me) {
    const name = el('input', { placeholder: 'Your name', maxLength: 40, value: myName() });
    name.dataset.keep = '1';
    const go = btn('Join channels', () => { save('wifiroom.myName', name.value.trim()); identify(); });
    return [h3('Channels'), el('p', { className: 'note', textContent: ch.nameError ?? 'Channels are kept on the device hosting the room, so everyone sees the same history.' }), el('div', { className: 'row' }, name, go)];
  }
  const row = (c) => el('button', { className: `chat-row${view.chatId === c.id ? ' on' : ''}`, type: 'button', onclick: () => openChannel(c.id) },
    el('span', {}, isPublic(c) ? '#' : '🔒'),
    el('span', { className: 'who' }, c.name, el('div', { textContent: c.call?.members.length ? `📞 ${c.call.members.length} on a call · ${c.call.members.map((m) => nameOfUid(m.uid)).join(', ')}` : c.topic || `${c.members.length} people${c.joined ? '' : ' · tap to join'}` })),
    el('span', { className: `badge${c.mention ? ' at' : ''}`, textContent: ch.unread[c.id] ? (c.mention ? '@' : '') + ch.unread[c.id] : '' }));
  const pub = ch.list.filter(isPublic).sort((a, b) => (a.id === 'general' ? -1 : b.id === 'general' ? 1 : b.last - a.last));
  const priv = ch.list.filter((c) => !isPublic(c)).sort((a, b) => b.last - a.last);
  const online = Object.values(ch.people).filter((p) => p.online).length;
  return [
    h3(`Channels · ${online} online`), ...pub.map(row),
    ...(priv.length ? [h3('Private rooms'), ...priv.map(row)] : []),
    el('p', {}, btn('＋ New channel', () => { view.screen = 'newchannel'; renderChats(); }, 'ghost')),
  ];
}

function newChannelScreen(body, sub, back) {
  $('chats-title').textContent = '＋ New channel';
  back.style.display = '';
  sub.replaceChildren();
  const name = el('input', { placeholder: 'name (letters, digits, dashes)', maxLength: 30, value: ch.draft.name ?? '' });
  const topic = el('input', { placeholder: 'What is it for? (optional)', maxLength: 120, value: ch.draft.topic ?? '' });
  [name, topic].forEach((i) => { i.dataset.keep = '1'; });
  name.oninput = () => { ch.draft.name = name.value; };
  topic.oninput = () => { ch.draft.topic = topic.value; };
  const kind = el('select', {}, el('option', { value: 'public', textContent: '# Public: anyone in the room can join' }), el('option', { value: 'private', textContent: '🔒 Private room: only people you pick' }));
  kind.value = ch.draft.kind ?? 'public';
  const picks = el('div');
  const people = Object.entries(ch.people).filter(([id]) => id !== ch.me);
  const renderPicks = () => {
    picks.replaceChildren(...(kind.value === 'private' ? [h3('Members'), ...people.map(([id, p]) => {
      const box = el('input', { type: 'checkbox', checked: ch.draft.members?.has(id) ?? false });
      box.onchange = () => { (ch.draft.members ??= new Set())[box.checked ? 'add' : 'delete'](id); };
      return el('label', { className: 'pick' }, box, `${p.name}${p.online ? '' : ' (away)'}`);
    }), ...(people.length ? [] : [el('p', { className: 'note', textContent: 'Nobody else has joined channels yet; you can add people later.' })])] : []));
  };
  kind.onchange = () => { ch.draft.kind = kind.value; renderPicks(); };
  renderPicks();
  const hostOnly = ch.host ? el('label', { className: 'pick' }, el('input', { type: 'checkbox' }), 'Announcements: only the host can post') : null;
  const create = btn('Create', () => {
    socket.emit('channel-create', { name: name.value, topic: topic.value, kind: kind.value, members: [...(ch.draft.members ?? [])], hostOnly: hostOnly?.firstChild.checked }, (r) => {
      if (!r.ok) return toast(`⚠️ ${r.error}`);
      ch.draft = {};
      openChannel(r.id);
    });
  });
  body.replaceChildren(el('p', {}, name), el('p', {}, topic), el('p', {}, kind), picks, ...(hostOnly ? [hostOnly] : []), el('p', {}, create));
}

function channelScreen(body, sub, back, form) {
  const c = byId(view.chatId);
  if (!c) { view.screen = 'list'; return renderChats(); }
  $('chats-title').textContent = `${isPublic(c) ? '#' : '🔒'} ${c.name}`;
  back.style.display = form.style.display = '';
  // The channel's call: join it, or start one. Once in it, the call bar at the top has the controls.
  const inThis = call?.channel === c.id, n = c.call?.members.length ?? 0;
  $('chats-call').style.display = inThis ? 'none' : '';
  $('chats-call').textContent = n ? `📞 Join (${n})` : '📞';
  $('chats-call').title = n ? 'Join the call' : 'Start a call in this channel';
  const members = c.members.map(nameOfUid).join(', ');
  const tools = el('details', {}, el('summary', { textContent: `${c.members.length} people${c.topic ? ` · ${c.topic}` : ''}` }), el('p', { className: 'note', textContent: members }));
  const invitable = Object.entries(ch.people).filter(([id]) => !c.members.includes(id));
  if (invitable.length) {
    const sel = el('select', {}, el('option', { value: '', textContent: '＋ Add someone…' }), ...invitable.map(([id, p]) => el('option', { value: id, textContent: p.name })));
    sel.onchange = () => sel.value && socket.emit('channel-invite', { id: c.id, who: sel.value }, (r) => r.ok || toast(`⚠️ ${r.error}`));
    tools.append(sel);
  }
  if (c.id !== 'general') tools.append(el('p', {}, btn('Leave', () => socket.emit('channel-leave', { id: c.id }, (r) => { if (r.ok) { delete ch.msgs[c.id]; openChats(); } else toast(`⚠️ ${r.error}`); }), 'ghost')));
  sub.replaceChildren(tools);
  if (n) tools.before(el('p', { className: 'oncall' }, el('span', { textContent: `📞 ${c.call.members.map((m) => `${m.muted ? '🔇 ' : ''}${nameOfUid(m.uid)}`).join(', ')}` }), ...(inThis ? [] : [btn('Join', () => joinChannelCall(c.id), 'sm')])));
  if (c.pinned?.length) tools.before(el('details', { className: 'pins' }, el('summary', { textContent: `📌 ${c.pinned.length} pinned` }), ...c.pinned.map((m) => el('p', { className: 'note', textContent: `${nameOfUid(m.from)}: ${m.text}` }))));
  const list = ch.msgs[c.id] ?? [];
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  let divider = false;
  const rows = [];
  for (const m of list) {
    if (!divider && ch.openedAt && m.ts > ch.openedAt && !m.system && m.from !== ch.me) { divider = true; rows.push(el('div', { className: 'newline', textContent: 'new messages' })); }
    if (m.system) { rows.push(el('div', { className: 'msg system', textContent: m.text })); continue; }
    if (m.deleted) { rows.push(el('div', { className: 'msg system', textContent: `${nameOfUid(m.from)} deleted a message` })); continue; }
    const mine = m.from === ch.me, mentionsMe = m.mentions?.includes(ch.me);
    const text = el('span', { className: 'text' }, ...m.text.split(/(@[^@\n]{1,40})/).map((part, i) => (i % 2 ? el('b', { className: 'mention', textContent: part }) : part)));
    const acts = el('span', { className: 'acts' },
      ...REACT.map((e) => btn(e, () => socket.emit('channel-react', { id: c.id, msg: m.id, emoji: e }), 'emoji sm')),
      ...(ch.host || c.by === ch.me ? [btn(m.pinned ? '📌 unpin' : '📌', () => socket.emit('channel-pin', { id: c.id, msg: m.id, pinned: !m.pinned }), 'ghost sm')] : []),
      ...(mine || ch.host ? [btn('🗑', () => confirm('Delete this message?') && socket.emit('channel-delete', { id: c.id, msg: m.id }), 'ghost sm')] : []));
    const reacts = m.reactions && Object.keys(m.reactions).length ? el('div', { className: 'reacts' }, ...Object.entries(m.reactions).map(([e, who]) => btn(`${e} ${who.length}`, () => socket.emit('channel-react', { id: c.id, msg: m.id, emoji: e }), `react${who.includes(ch.me) ? ' on' : ''}`))) : null;
    rows.push(el('div', { className: `msg${mine ? ' mine' : ''}${mentionsMe ? ' tome' : ''}${m.pinned ? ' pinned' : ''}` },
      ...(!mine ? [el('span', { className: 'meta', textContent: `${nameOfUid(m.from)} ${nameTag(m.from)}${m.pinned ? ' · 📌' : ''}` })] : []),
      text, acts,
      el('span', { className: 'meta', textContent: new Date(m.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }),
      ...(reacts ? [reacts] : [])));
  }
  body.replaceChildren(
    ...(ch.more[c.id] ? [el('p', { style: 'text-align:center' }, btn('Earlier messages', () => loadOlder(c.id), 'ghost'))] : []),
    ...(rows.length ? rows : [el('p', { className: 'note', textContent: c.host ? 'Announcements from the host appear here.' : 'No messages yet.' })]));
  renderTyping(c.id);
  if (atBottom || body.dataset.chat !== c.id) body.scrollTop = body.scrollHeight;
  body.dataset.chat = c.id;
  $('chats-text').placeholder = c.host && !ch.host ? 'Only the host posts here' : `Message #${c.name}`;
  $('chats-text').disabled = !!c.host && !ch.host;
}
