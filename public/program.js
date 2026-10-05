// Program, Games and People panes, as Preact components (htm + Preact, no build step).
// The program lives on the host device (program.js on the server); the host edits, everyone else
// sees it, votes in polls and signs up for things.
import { html, render, useState } from '/lib/htm-preact.js';

const prog = { data: null };
const me = () => window.ch?.me;
const amHost = () => !!window.ch?.host;
const ask = (event, payload) => new Promise((ok) => socket.emit(event, payload, ok));
const act = async (event, payload) => { const r = await ask(event, payload); if (!r?.ok) toast(`⚠️ ${r?.error ?? 'Failed'}`); return r; };
const day = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const localInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromInput = (v) => (v ? new Date(v).getTime() : null);
const nowish = () => { const d = new Date(); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0); return localInput(d.getTime()); };

// ---- pieces ----
const Card = ({ title, children, right }) => html`<section class="card2"><div class="card2-head"><h3>${title}</h3>${right}</div>${children}</section>`;
const Empty = ({ icon, children }) => html`<div class="empty"><div style="font-size:40px">${icon}</div>${children}</div>`;

function NamePrompt() {
  const [name, setName] = useState(load('wifiroom.myName', '') || state.name || '');
  return html`<${Empty} icon="📅">
    <p>Pick a name to see the program and join in.</p>
    <div class="row" style="max-width:320px"><input value=${name} maxLength=${40} placeholder="Your name" onInput=${(e) => setName(e.target.value)} />
      <button onClick=${() => { save('wifiroom.myName', name.trim()); identify(); }}>Continue</button></div>
  <//>`;
}

function Title({ p }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(p.title);
  if (editing) return html`<div class="row" style="margin-bottom:12px"><input value=${v} maxLength=${80} placeholder="Game night, Team offsite, Resort · Sat…" onInput=${(e) => setV(e.target.value)} />
    <button onClick=${async () => { await act('program-title', { title: v }); setEditing(false); }}>Save</button><button class="ghost" onClick=${() => setEditing(false)}>Cancel</button></div>`;
  return html`<div class="row" style="margin-bottom:12px"><h2 style="margin:0;font-size:20px;flex:1">${p.title || (amHost() ? 'Name this program' : 'Program')}</h2>
    ${amHost() && html`<button class="ghost" onClick=${() => { setV(p.title); setEditing(true); }}>✏️</button>`}</div>`;
}

function NowNext({ items }) {
  const t = Date.now();
  const now = items.filter((i) => i.start <= t && (i.end ? t < i.end : t - i.start < 2 * 3600e3));
  const next = items.find((i) => i.start > t);
  if (!now.length && !next) return null;
  return html`<div class="nownext">
    ${now.map((i) => html`<div class="now" key=${i.id}><div class="tag">NOW</div><b>${i.title}</b><div class="note">${hm(i.start)}${i.end ? ` – ${hm(i.end)}` : ''}${i.where ? ` · ${i.where}` : ''}</div></div>`)}
    ${next && html`<div class="next"><div class="tag">NEXT</div><b>${next.title}</b><div class="note">${sameDay(next.start, t) ? '' : `${day(next.start)} `}${hm(next.start)}${next.where ? ` · ${next.where}` : ''}</div></div>`}
  </div>`;
}

function ScheduleForm({ item, onDone }) {
  const [f, setF] = useState({ title: item?.title ?? '', start: item ? localInput(item.start) : nowish(), end: item?.end ? localInput(item.end) : '', where: item?.where ?? '', notes: item?.notes ?? '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return html`<div class="form">
    <input placeholder="What" value=${f.title} maxLength=${80} onInput=${set('title')} />
    <div class="row"><label class="note">From</label><input type="datetime-local" value=${f.start} onInput=${set('start')} /><label class="note">To</label><input type="datetime-local" value=${f.end} onInput=${set('end')} /></div>
    <input placeholder="Where (optional)" value=${f.where} maxLength=${60} onInput=${set('where')} />
    <input placeholder="Notes (optional)" value=${f.notes} maxLength=${300} onInput=${set('notes')} />
    <div class="row"><button onClick=${async () => { const r = await act('schedule-save', { id: item?.id, title: f.title, start: fromInput(f.start), end: fromInput(f.end), where: f.where, notes: f.notes }); if (r.ok) onDone(); }}>${item ? 'Save' : 'Add'}</button><button class="ghost" onClick=${onDone}>Cancel</button></div>
  </div>`;
}

function Schedule({ items }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const t = Date.now();
  const days = [];
  for (const i of items) { const d = day(i.start); (days.find((x) => x.d === d) ?? days[days.push({ d, items: [] }) - 1]).items.push(i); }
  return html`<${Card} title="Schedule" right=${amHost() && !adding && html`<button class="ghost" onClick=${() => setAdding(true)}>＋ Add</button>`}>
    ${adding && html`<${ScheduleForm} onDone=${() => setAdding(false)} />`}
    ${!items.length && !adding && html`<p class="note">${amHost() ? 'Nothing scheduled yet. Add the first thing.' : 'Nothing scheduled yet.'}</p>`}
    ${days.map(({ d, items }) => html`<div key=${d}><div class="dayhead">${d}</div>
      ${items.map((i) => editing === i.id ? html`<${ScheduleForm} key=${i.id} item=${i} onDone=${() => setEditing(null)} />` : html`<div class="item ${i.end ? t >= i.end : t - i.start > 2 * 3600e3 ? 'past' : ''}" key=${i.id}>
        <div class="when">${hm(i.start)}${i.end ? html`<br/><span class="note">${hm(i.end)}</span>` : ''}</div>
        <div class="what"><b>${i.title}</b>${i.where && html`<div class="note">📍 ${i.where}</div>`}${i.notes && html`<div class="note">${i.notes}</div>`}</div>
        ${amHost() && html`<div class="row"><button class="ghost sm" onClick=${() => setEditing(i.id)}>✏️</button><button class="ghost sm" onClick=${() => confirm(`Remove "${i.title}"?`) && act('schedule-delete', { id: i.id })}>🗑</button></div>`}
      </div>`)}
    </div>`)}
  <//>`;
}

function Polls({ polls }) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState('');
  return html`<${Card} title="Polls" right=${amHost() && !adding && html`<button class="ghost" onClick=${() => setAdding(true)}>＋ New poll</button>`}>
    ${adding && html`<div class="form"><input placeholder="Question" value=${q} maxLength=${140} onInput=${(e) => setQ(e.target.value)} />
      <textarea rows="4" placeholder="One option per line" value=${opts} onInput=${(e) => setOpts(e.target.value)}></textarea>
      <div class="row"><button onClick=${async () => { const r = await act('poll-create', { question: q, options: opts.split('\n') }); if (r.ok) { setQ(''); setOpts(''); setAdding(false); } }}>Start poll</button><button class="ghost" onClick=${() => setAdding(false)}>Cancel</button></div></div>`}
    ${!polls.length && !adding && html`<p class="note">No polls yet.</p>`}
    ${polls.map((p) => html`<div class="poll ${p.open ? '' : 'closed'}" key=${p.id}>
      <div class="row"><b style="flex:1">${p.question}</b><span class="note">${p.open ? `${p.total} vote${p.total === 1 ? '' : 's'}` : `Closed · ${p.total} votes`}</span></div>
      ${p.options.map((o, i) => html`<button class="opt ${o.mine ? 'mine' : ''}" disabled=${!p.open} onClick=${() => act('poll-vote', { id: p.id, option: i })}>
        <span class="bar" style=${`width:${p.total ? Math.round((100 * o.votes) / p.total) : 0}%`}></span><span class="txt">${o.mine ? '✓ ' : ''}${o.text}</span><span class="n">${o.votes}</span></button>`)}
      ${amHost() && html`<div class="row" style="margin-top:4px"><button class="ghost sm" onClick=${() => act('poll-close', { id: p.id, open: !p.open })}>${p.open ? 'Close' : 'Reopen'}</button><button class="ghost sm" onClick=${() => confirm('Delete this poll?') && act('poll-delete', { id: p.id })}>🗑</button></div>`}
    </div>`)}
  <//>`;
}

function Signups({ sheets }) {
  const [adding, setAdding] = useState(false);
  const [t, setT] = useState('');
  const [max, setMax] = useState('');
  return html`<${Card} title="Sign-ups" right=${amHost() && !adding && html`<button class="ghost" onClick=${() => setAdding(true)}>＋ New sheet</button>`}>
    ${adding && html`<div class="form"><div class="row"><input placeholder="Karaoke 9pm, Volleyball team, Early breakfast…" value=${t} maxLength=${80} onInput=${(e) => setT(e.target.value)} /><input type="number" min="1" placeholder="Max" style="flex:0 0 80px" value=${max} onInput=${(e) => setMax(e.target.value)} /></div>
      <div class="row"><button onClick=${async () => { const r = await act('signup-create', { title: t, max: max ? Number(max) : null }); if (r.ok) { setT(''); setMax(''); setAdding(false); } }}>Create</button><button class="ghost" onClick=${() => setAdding(false)}>Cancel</button></div></div>`}
    ${!sheets.length && !adding && html`<p class="note">No sign-up sheets yet.</p>`}
    ${sheets.map((s) => html`<div class="item" key=${s.id}>
      <div class="what"><b>${s.title}</b><div class="note">${s.people.length}${s.max ? ` / ${s.max}` : ''} signed up${s.people.length ? `: ${s.people.join(', ')}` : ''}</div></div>
      <div class="row"><button class=${s.mine ? 'ghost' : ''} disabled=${!s.mine && s.max && s.people.length >= s.max} onClick=${() => act('signup-toggle', { id: s.id })}>${s.mine ? 'Leave' : s.max && s.people.length >= s.max ? 'Full' : 'Join'}</button>
        ${amHost() && html`<button class="ghost sm" onClick=${() => confirm('Delete this sheet?') && act('signup-delete', { id: s.id })}>🗑</button>`}</div>
    </div>`)}
  <//>`;
}

function Announcements() {
  const msgs = (window.ch?.msgs?.announcements ?? []).filter((m) => !m.system).slice(-3);
  return html`<${Card} title="Announcements" right=${html`<button class="ghost" onClick=${() => openChannel('announcements')}>${amHost() ? 'Post' : 'Open'} #announcements</button>`}>
    ${msgs.length ? msgs.map((m) => html`<div class="item" key=${m.id}><div class="when note">${hm(m.ts)}</div><div class="what">${m.text}</div></div>`) : html`<p class="note">${amHost() ? 'Nothing posted yet. Announcements reach everyone, even people not in other channels.' : 'Nothing from the host yet.'}</p>`}
  <//>`;
}

function Program() {
  if (!me()) return html`<${NamePrompt} />`;
  const p = prog.data;
  if (!p) return html`<${Empty} icon="📅"><p>Loading the program…</p><//>`;
  return html`<div class="program">
    <${Title} p=${p} />
    <${NowNext} items=${p.schedule} />
    <${Announcements} />
    <${Schedule} items=${p.schedule} />
    <${Polls} polls=${p.polls} />
    <${Signups} sheets=${p.signups} />
  </div>`;
}

// ---- People: everyone known to the host's channels, online first ----
function People() {
  const people = Object.entries(window.ch?.people ?? {}).map(([id, p]) => ({ id, ...p })).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  if (!people.length) return html`<${Empty} icon="👥"><p>Nobody has joined channels yet. Open Chats and pick a name.</p><//>`;
  return html`<div>
    <h3>${people.filter((p) => p.online).length} here now</h3>
    ${people.map((p) => html`<div class="chat-row" key=${p.id}><span>${p.online ? '🟢' : '⚪'}</span><span class="who">${p.name}${p.id === me() ? ' (you)' : ''}${p.host ? ' · host' : ''}<div>${p.online ? 'online' : `last seen ${new Date(p.seen).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</div></span></div>`)}
  </div>`;
}

const Games = () => html`<${Empty} icon="🎲"><p><b>Games: coming next</b></p><p class="note">Buzzer quiz, bingo, "most likely to", and board games, with lobbies and a scoreboard per night.</p><//>`;

const draw = () => {
  render(html`<${Program} />`, document.getElementById('program'));
  render(html`<${People} />`, document.getElementById('people'));
  render(html`<${Games} />`, document.getElementById('games'));
};
draw();
window.addEventListener('pane', draw);
socket.on('program', (p) => { prog.data = p; draw(); });
socket.on('channels', () => { if (window.ch?.me && !window.ch.msgs.announcements) socket.emit('channel-history', { id: 'announcements' }, (r) => { if (r.ok) { window.ch.msgs.announcements = r.messages; draw(); } }); draw(); });
socket.on('channel-msg', ({ channel }) => channel === 'announcements' && draw());
setInterval(() => document.body.dataset.pane === 'program' && draw(), 60_000); // Now / Next moves with the clock
