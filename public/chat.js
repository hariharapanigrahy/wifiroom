// Private and small group chats, end-to-end encrypted with tweetnacl's nacl.box (X25519 + XSalsa20-Poly1305).
// Phones open the room over plain http, where crypto.subtle doesn't exist; tweetnacl only needs
// crypto.getRandomValues, which does. Each browser keeps its secret key; the server only ever sees public
// keys and ciphertext. A group message is encrypted once for each member.
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

const chatKeyPair = (() => {
  const secret = load('wifiroom.chatSecret', null);
  if (secret) try { return nacl.box.keyPair.fromSecretKey(fromB64(secret)); } catch {}
  const k = nacl.box.keyPair();
  save('wifiroom.chatSecret', toB64(k.secretKey));
  return k;
})();
const myChatKey = () => toB64(chatKeyPair.publicKey);

// A short number derived from a public key. If two people see the same code for each other, nobody
// (not even the computer running the room) swapped keys in between.
const securityCode = (key) => {
  const h = nacl.hash(fromB64(key));
  return [0, 2, 4, 6].map((i) => String(((h[i] << 8) | h[i + 1]) % 1000).padStart(3, '0')).join(' ');
};

// Chats and messages are kept only in this browser.
const chats = load('wifiroom.chats', {});    // chatId -> { id, kind: 'dm' | 'group', name, members: [ids], msgs: [], unread }
const pins = load('wifiroom.chatPins', {});  // deviceId -> the first key we saw for them
const saveChats = () => save('wifiroom.chats', chats);
const view = { screen: 'list', chatId: null, picked: new Set() };
const MAX_PICKS = 5; // small groups: you plus up to five others

const dmId = (a, b) => `dm:${[a, b].sort().join('+')}`;
const personName = (id) => (id === myId() ? 'You' : state.devices.get(id) ? nameOf(state.devices.get(id)) : chats.names?.[id] ?? 'Someone');
const keyOf = (id) => state.devices.get(id)?.chatKey;
const others = (chat) => chat.members.filter((m) => m !== myId());
const chatName = (chat) => (chat.kind === 'dm' ? personName(others(chat)[0]) : chat.name || others(chat).map(personName).join(', '));
const reachable = () => [...state.devices.values()].filter((d) => d.chatKey && d.id !== myId());
// People you might want to chat with who don't have the room page open right now (named devices and phones).
const canInvite = (d) => !d.isSelf && d.id !== myId() && (d.nickname || d.randomMac);
const notReachable = () => [...state.devices.values()].filter((d) => !d.chatKey && canInvite(d));
const roomAddress = () => view.joinUrl || location.origin;
const notHere = (d) => `${nameOf(d)} needs the room open to chat. Ask them to open ${roomAddress()} on their phone.`;
const waitingList = () => {
  const list = notReachable();
  return list.length ? [el('p', { className: 'note', textContent: `Not on the room page right now, so they can't get messages yet: ${list.map(nameOf).join(', ')}. Ask them to open ${roomAddress()} on their phone; they'll show up here once they do.` })] : [];
};

function addMsg(chat, msg, { unread = false } = {}) {
  chat.msgs.push(msg);
  chat.msgs = chat.msgs.slice(-200);
  chat.updated = msg.ts;
  if (unread && !(view.screen === 'chat' && view.chatId === chat.id && $('chats').classList.contains('open'))) chat.unread = (chat.unread ?? 0) + 1;
  saveChats();
}

function ensureChat(id, kind, members, name) {
  const chat = (chats[id] ??= { id, kind, members, name: name ?? '', msgs: [], unread: 0 });
  if (kind === 'group') { chat.members = members; if (name !== undefined) chat.name = name; }
  return chat;
}

// Remember names, so old chats still read well after someone leaves the room.
function rememberNames() {
  chats.names ??= {};
  for (const d of state.devices.values()) chats.names[d.id] = nameOf(d);
}

// Encrypt one payload for every other member and hand the boxes to the server.
function sendPayload(chat, payload, done) {
  const boxes = [], missed = [];
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  for (const id of others(chat)) {
    const key = keyOf(id);
    if (!key) { missed.push(id); continue; }
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    boxes.push({ to: id, nonce: toB64(nonce), box: toB64(nacl.box(plain, nonce, fromB64(key), chatKeyPair.secretKey)) });
  }
  if (!boxes.length) return done?.({ ok: true, missed });
  socket.emit('dm', { boxes }, (r) => done?.(r.ok ? { ok: true, missed: [...missed, ...r.missed] } : r));
}

function send(text) {
  const chat = chats[view.chatId];
  if (!chat || !text.trim()) return;
  const ts = Date.now();
  const payload = { t: 'msg', chat: { id: chat.id, kind: chat.kind, name: chat.name, members: chat.members }, text: text.slice(0, 1000), ts };
  addMsg(chat, { from: myId(), text: payload.text, ts });
  renderChats();
  sendPayload(chat, payload, (r) => {
    if (!r.ok) addMsg(chat, { system: true, text: `⚠️ Not sent: ${r.error}`, ts: Date.now() });
    else if (r.missed.length) addMsg(chat, { system: true, text: `Not delivered to ${r.missed.map(personName).join(', ')}: not in the room right now.`, ts: Date.now() });
    renderChats();
  });
}

socket.on('dm', ({ from, nonce, box }) => {
  const me = myId();
  // Try the key the room offers now and the one we first saw (in case a reconnect hasn't caught up yet).
  let plain = null;
  for (const key of new Set([keyOf(from), pins[from]].filter(Boolean))) {
    plain = nacl.box.open(fromB64(box), fromB64(nonce), fromB64(key), chatKeyPair.secretKey);
    if (plain) break;
  }
  if (!plain || !me) return; // not for this browser's key (another browser on the same device, say)
  let p;
  try { p = JSON.parse(new TextDecoder().decode(plain)); } catch { return; }
  const c = p.chat ?? {};
  const members = Array.isArray(c.members) ? c.members.map(String).slice(0, 12) : [];
  let chat;
  if (c.kind === 'group' && /^g:[0-9a-f]{16}$/.test(c.id) && members.includes(from) && members.includes(me)) {
    chat = ensureChat(c.id, 'group', members, String(c.name ?? '').slice(0, 40));
  } else if (p.t === 'leave' && chats[c.id]?.kind === 'group') {
    chat = chats[c.id];
    chat.members = chat.members.filter((m) => m !== from);
    addMsg(chat, { system: true, text: `${personName(from)} left the group.`, ts: Date.now() });
    return renderChats(), updateBadge();
  } else if (c.kind === 'group') {
    return; // a group we aren't in, or a malformed one
  } else {
    chat = ensureChat(dmId(me, from), 'dm', [me, from]);
  }
  if (p.t === 'invite') {
    if (!chat.msgs.length) addMsg(chat, { system: true, text: `${personName(from)} added you to this group.`, ts: Date.now() }, { unread: true });
    toast(`👥 ${personName(from)} added you to ${chatName(chat)}`);
    return renderChats(), updateBadge();
  }
  if (/^(file|call)/.test(p.t)) return onP2p(from, chat, p), updateBadge(); // see p2p.js
  if (p.t !== 'msg' || typeof p.text !== 'string') return;
  addMsg(chat, { from, text: p.text.slice(0, 1000), ts: Date.now() }, { unread: true });
  const open = view.screen === 'chat' && view.chatId === chat.id && $('chats').classList.contains('open');
  if (!open) {
    toast(`💬 ${personName(from)}${chat.kind === 'group' ? ` in ${chatName(chat)}` : ''}: ${p.text.slice(0, 60)}`);
    navigator.vibrate?.(120);
    if (document.hidden) notify(`New private message from ${personName(from)}`);
  }
  renderChats();
  updateBadge();
});

// Watch for keys that change after we first saw them, and say so in the chats with that person.
function checkKeys() {
  for (const d of state.devices.values()) {
    if (!d.chatKey || d.id === myId()) continue;
    if (!pins[d.id]) pins[d.id] = d.chatKey;
    else if (pins[d.id] !== d.chatKey) {
      pins[d.id] = d.chatKey;
      for (const chat of Object.values(chats)) if (chat.members?.includes(d.id)) {
        addMsg(chat, { system: true, text: `⚠️ ${nameOf(d)}'s security code changed (new browser, or cleared data?). Check the new code with them before sharing anything private.`, ts: Date.now() });
      }
    }
  }
  save('wifiroom.chatPins', pins);
}

// ================= Chats screen =================
const chatList = () => Object.values(chats).filter((c) => c && c.id).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));

function updateBadge() {
  const n = chatList().reduce((sum, c) => sum + (c.unread ?? 0), 0) + (typeof channelUnread === 'function' ? channelUnread() : 0);
  $('chats-badge').textContent = n ? String(n) : '';
}

function openChats(chatId) {
  view.screen = chatId ? 'chat' : 'list';
  view.chatId = chatId ?? null;
  showPane('chats');
  renderChats();
  if (chatId) $('chats-text').focus();
}

function openDm(id) {
  const me = myId();
  if (!me) return;
  ensureChat(dmId(me, id), 'dm', [me, id]);
  saveChats();
  closePanel();
  openChats(dmId(me, id));
}

// The Chats pane: a list of channels and people on the left, the open conversation on the right
// (stacked on phones: the list, then the conversation with a back button).
function renderChats() {
  updateBadge();
  if (!$('chats').classList.contains('open')) return;
  // Don't clobber a form someone is typing in (a group or channel name); the message box itself is fine to render around.
  if ($('chats').contains(document.activeElement) && document.activeElement.dataset.keep && document.activeElement.id !== 'chats-text') return;
  rememberNames();
  $('chats').classList.toggle('conv', view.screen !== 'list');
  renderChatList();
  renderConversation();
}

function renderChatList() {
  const people = reachable();
  const rows = chatList().map((c) => {
    const last = c.msgs.at(-1);
    return el('button', { className: `chat-row${view.chatId === c.id ? ' on' : ''}`, type: 'button', onclick: () => openChats(c.id) },
      el('span', {}, c.kind === 'group' ? '👥' : '💬'),
      el('span', { className: 'who' }, chatName(c), el('div', { textContent: last ? `${last.system ? '' : last.from === myId() ? 'You: ' : c.kind === 'group' ? `${personName(last.from)}: ` : ''}${last.text ?? `📎 ${last.file?.name}`}` : 'No messages yet' })),
      el('span', { className: 'badge', textContent: c.unread ? String(c.unread) : '' }));
  });
  const start = people.filter((d) => !chats[dmId(myId(), d.id)]).map((d) => el('button', { className: 'chat-row', type: 'button', onclick: () => openDm(d.id) }, el('span', {}, '➕'), el('span', { className: 'who', textContent: nameOf(d) })));
  $('chats-list').replaceChildren(...channelSection(),
    h3('Direct messages'),
    ...rows,
    ...(start.length ? [h3('Start a private chat'), ...start] : rows.length ? [] : [el('p', { className: 'note', textContent: people.length ? '' : `Nobody else is in the room yet. Others join by opening ${roomAddress()} on their phone.` })]),
    ...waitingList(),
    el('p', {}, btn('👥 New group', () => { view.screen = 'new'; view.picked.clear(); renderChats(); }, 'ghost')),
    el('p', { className: 'lock' }, '🔒 Direct messages are end-to-end encrypted and kept only on your device. Your security code: ', el('b', { textContent: securityCode(myChatKey()) })));
}

function renderConversation() {
  const body = $('chats-body'), sub = $('chats-sub');
  const form = $('chats-form'), back = $('chats-back');
  if (view.screen === 'channel') return channelScreen(body, sub, back, form);
  if (view.screen === 'newchannel') { form.style.display = $('chats-call').style.display = 'none'; return newChannelScreen(body, sub, back); }
  if (view.screen === 'chat' && chats[view.chatId]) {
    const chat = chats[view.chatId];
    chat.unread = 0;
    saveChats();
    updateBadge();
    $('chats-title').textContent = `${chat.kind === 'group' ? '👥' : '💬'} ${chatName(chat)}`;
    back.style.display = form.style.display = $('chats-call').style.display = '';
    if (chat.kind === 'dm') {
      const key = keyOf(others(chat)[0]) ?? pins[others(chat)[0]];
      sub.replaceChildren(el('p', { className: 'lock' }, '🔒 End-to-end encrypted. ', ...(key ? ['Security code ', el('b', { textContent: securityCode(key) }), '. Theirs for you should read ', el('b', { textContent: securityCode(myChatKey()) }), '.'] : ['They need to be in the room to get messages.'])));
    } else {
      const list = el('ul', {}, ...others(chat).map((id) => el('li', { textContent: `${personName(id)}: ${keyOf(id) ?? pins[id] ? securityCode(keyOf(id) ?? pins[id]) : 'not in the room'}` })));
      sub.replaceChildren(el('p', { className: 'lock' }, `🔒 End-to-end encrypted · ${chat.members.length} people`),
        el('details', {}, el('summary', { textContent: 'Security codes' }), el('p', { textContent: `Yours: ${securityCode(myChatKey())}` }), list,
          btn('Leave group', () => {
            sendPayload(chat, { t: 'leave', chat: { id: chat.id, kind: 'group' } });
            delete chats[chat.id]; saveChats(); openChats();
          }, 'ghost')));
    }
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.replaceChildren(...(chat.msgs.length ? chat.msgs.map((m) => m.system ? el('div', { className: 'msg system', textContent: m.text })
      : el('div', { className: `msg${m.from === myId() ? ' mine' : ''}` },
        ...(chat.kind === 'group' && m.from !== myId() ? [el('span', { className: 'meta', textContent: personName(m.from) })] : []),
        ...(m.file ? fileView(m) : [m.text]),
        el('span', { className: 'meta', textContent: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })))
      : [el('p', { className: 'note', textContent: 'No messages yet. Only the people in this chat can read what you send; the computer running the room just passes along scrambled text.' })]));
    if (atBottom || body.dataset.chat !== chat.id) body.scrollTop = body.scrollHeight;
    body.dataset.chat = chat.id;
    return;
  }
  form.style.display = $('chats-call').style.display = 'none';
  body.dataset.chat = '';
  const people = reachable();
  if (view.screen === 'new') {
    $('chats-title').textContent = '👥 New group';
    back.style.display = '';
    sub.replaceChildren(el('p', { className: 'note', textContent: `Pick up to ${MAX_PICKS} people in the room.` }));
    const name = el('input', { placeholder: 'Group name (optional)', maxLength: 40, value: view.groupName ?? '' });
    name.dataset.keep = '1';
    name.oninput = () => { view.groupName = name.value; };
    const picks = people.map((d) => {
      const box = el('input', { type: 'checkbox', checked: view.picked.has(d.id) });
      box.onchange = () => { box.checked ? view.picked.add(d.id) : view.picked.delete(d.id); if (view.picked.size > MAX_PICKS) { view.picked.delete(d.id); box.checked = false; toast(`Groups are up to ${MAX_PICKS} people plus you`); } };
      return el('label', { className: 'pick' }, box, nameOf(d));
    });
    const create = btn('Create group', () => {
      const members = [myId(), ...[...view.picked].filter((id) => keyOf(id))];
      if (members.length < 3) return toast('Pick at least two people');
      const id = `g:${[...nacl.randomBytes(8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      const chat = ensureChat(id, 'group', members, (view.groupName ?? '').trim().slice(0, 40));
      addMsg(chat, { system: true, text: `You started this group with ${others(chat).map(personName).join(', ')}.`, ts: Date.now() });
      sendPayload(chat, { t: 'invite', chat: { id, kind: 'group', name: chat.name, members } });
      view.picked.clear(); view.groupName = '';
      saveChats();
      openChats(id);
    });
    body.replaceChildren(name, ...picks, ...(picks.length >= 2 ? [] : [el('p', { className: 'note', textContent: `A group needs at least two other people with the room page open${picks.length ? ' (only one is here now)' : ''}.` })]), ...waitingList(), el('p', {}, create));
    return;
  }
  $('chats-title').textContent = 'Chats';
  back.style.display = 'none';
  sub.replaceChildren();
  body.replaceChildren(el('div', { className: 'empty' }, el('div', { textContent: '💬', style: 'font-size:40px' }), el('p', { textContent: 'Pick a channel or a person.' })));
}

$('chats-back').onclick = () => openChats();
$('chats-attach').onclick = () => $('chats-file').click();
$('chats-file').onchange = () => { const chat = chats[view.chatId]; if (chat) shareFiles(chat, [...$('chats-file').files]); $('chats-file').value = ''; };
$('chats-call').onclick = () => { if (view.screen === 'channel') return joinChannelCall(view.chatId); const chat = chats[view.chatId]; if (chat) startCall(chat); };
$('chats-form').onsubmit = (e) => { e.preventDefault(); (view.screen === 'channel' ? sendToChannel(view.chatId, $('chats-text').value) : send($('chats-text').value)); $('chats-text').value = ''; $('chats-text').focus(); hideSuggest(); };
// While typing in a channel: a typing signal, and @name suggestions after an "@".
$('chats-text').addEventListener('input', () => {
  if (view.screen !== 'channel') return;
  socket.emit('channel-typing', { id: view.chatId });
  const v = $('chats-text').value, at = v.lastIndexOf('@');
  if (at < 0 || /\s/.test(v.slice(at + 1)) && v.slice(at + 1).length > 25) return hideSuggest();
  const q = v.slice(at + 1).toLowerCase();
  const c = (window.ch?.list ?? []).find((x) => x.id === view.chatId);
  const names = Object.entries(window.ch?.people ?? {}).filter(([id, p]) => id !== window.ch.me && (!c || c.members.includes(id)) && p.name.toLowerCase().startsWith(q)).map(([, p]) => p.name).slice(0, 6);
  if (window.ch?.host && 'everyone'.startsWith(q)) names.unshift('everyone');
  if (!names.length) return hideSuggest();
  let box = $('chats-suggest'); if (!box) { box = el('div', { id: 'chats-suggest', className: 'suggest' }); $('chats-form').before(box); }
  box.replaceChildren(...names.map((n) => btn(`@${n}`, () => { $('chats-text').value = `${v.slice(0, at)}@${n} `; $('chats-text').focus(); hideSuggest(); }, 'ghost sm')));
});
function hideSuggest() { $('chats-suggest')?.remove(); }

// Offer our key to the room (visitors send it with "join"; the host page has no join step) and keep the
// chats screen in step with who is around.
socket.on('hello', (h) => {
  if (view.build && h.build && h.build !== view.build) return location.reload(); // the room was restarted with new code
  view.build = h.build;
  view.joinUrl = h.joinUrl;
  if (h.host) socket.emit('chat-key', myChatKey());
});
socket.on('devices', () => { checkKeys(); renderChats(); });
updateBadge();
