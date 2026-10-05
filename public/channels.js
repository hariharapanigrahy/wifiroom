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
  socket.emit('identify', { key: myChatKey(), name }, (r) => { if (r?.ok) { ch.me = r.uid; ch.host = r.host; renderChats(); } });
}
socket.on('hello', () => setTimeout(identify, 100)); // after chat.js has registered the key
socket.on('you', identify);
socket.on('channels', ({ list, people }) => { ch.list = list; ch.people = people; renderChats(); });
socket.on('channel-msg', ({ channel, message }) => {
  (ch.msgs[channel] ??= []).push(message);
  const open = view.screen === 'channel' && view.chatId === channel && $('chats').classList.contains('open');
  if (!open && message.from !== ch.me) {
    ch.unread[channel] = (ch.unread[channel] ?? 0) + 1;
    if (!message.system) { toast(`#${channel} · ${nameOfUid(message.from)}: ${message.text.slice(0, 60)}`); if (document.hidden) notify(`#${channel}: ${nameOfUid(message.from)}`); }
  }
  renderChats();
});

const channelUnread = () => Object.values(ch.unread).reduce((a, b) => a + b, 0);

function openChannel(id) {
  const c = byId(id);
  if (!c) return;
  if (!c.joined) return socket.emit('channel-join', { id }, (r) => (r.ok ? openChannel(id) : toast(`⚠️ ${r.error}`)));
  view.screen = 'channel'; view.chatId = id;
  ch.unread[id] = 0;
  showPane('chats');
  if (!ch.msgs[id]) socket.emit('channel-history', { id }, (r) => { if (r.ok) { ch.msgs[id] = r.messages; ch.more[id] = r.more; renderChats(); } });
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
    return [h3('Channels'), el('p', { className: 'note', textContent: 'Channels are kept on the device hosting the room, so everyone sees the same history.' }), el('div', { className: 'row' }, name, go)];
  }
  const row = (c) => el('button', { className: `chat-row${view.chatId === c.id ? ' on' : ''}`, type: 'button', onclick: () => openChannel(c.id) },
    el('span', {}, isPublic(c) ? '#' : '🔒'),
    el('span', { className: 'who' }, c.name, el('div', { textContent: c.topic || `${c.members.length} people${c.joined ? '' : ' · tap to join'}` })),
    el('span', { className: 'badge', textContent: ch.unread[c.id] ? String(ch.unread[c.id]) : '' }));
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
  $('chats-call').style.display = 'none'; // calls per channel come later
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
  const list = ch.msgs[c.id] ?? [];
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.replaceChildren(
    ...(ch.more[c.id] ? [el('p', { style: 'text-align:center' }, btn('Earlier messages', () => loadOlder(c.id), 'ghost'))] : []),
    ...(list.length ? list.map((m) => m.system ? el('div', { className: 'msg system', textContent: m.text })
      : el('div', { className: `msg${m.from === ch.me ? ' mine' : ''}` },
        ...(m.from !== ch.me ? [el('span', { className: 'meta', textContent: nameOfUid(m.from) })] : []),
        m.text,
        el('span', { className: 'meta', textContent: new Date(m.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })))
      : [el('p', { className: 'note', textContent: c.host ? 'Announcements from the host appear here.' : 'No messages yet.' })]));
  if (atBottom || body.dataset.chat !== c.id) body.scrollTop = body.scrollHeight;
  body.dataset.chat = c.id;
  $('chats-text').placeholder = c.host && !ch.host ? 'Only the host posts here' : `Message #${c.name}`;
  $('chats-text').disabled = !!c.host && !ch.host;
}
