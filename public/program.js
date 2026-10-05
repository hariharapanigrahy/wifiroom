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
  return html`<${Card} title="Schedule" right=${!adding && html`<button class="ghost" onClick=${() => setAdding(true)}>＋ Add</button>`}>
    ${adding && html`<${ScheduleForm} onDone=${() => setAdding(false)} />`}
    ${!items.length && !adding && html`<p class="note">Nothing scheduled yet. Add the first thing.</p>`}
    ${days.map(({ d, items }) => html`<div key=${d}><div class="dayhead">${d}</div>
      ${items.map((i) => editing === i.id ? html`<${ScheduleForm} key=${i.id} item=${i} onDone=${() => setEditing(null)} />` : html`<div class="item ${i.end ? t >= i.end : t - i.start > 2 * 3600e3 ? 'past' : ''}" key=${i.id}>
        <div class="when">${hm(i.start)}${i.end ? html`<br/><span class="note">${hm(i.end)}</span>` : ''}</div>
        <div class="what"><b>${i.title}</b>${i.where && html`<div class="note">📍 ${i.where}</div>`}${i.notes && html`<div class="note">${i.notes}</div>`}</div>
        ${i.mine && html`<div class="row"><button class="ghost sm" onClick=${() => setEditing(i.id)}>✏️</button><button class="ghost sm" onClick=${() => confirm(`Remove "${i.title}"?`) && act('schedule-delete', { id: i.id })}>🗑</button></div>`}
      </div>`)}
    </div>`)}
  <//>`;
}

function Polls({ polls }) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState('');
  return html`<${Card} title="Polls" right=${!adding && html`<button class="ghost" onClick=${() => setAdding(true)}>＋ New poll</button>`}>
    ${adding && html`<div class="form"><input placeholder="Question" value=${q} maxLength=${140} onInput=${(e) => setQ(e.target.value)} />
      <textarea rows="4" placeholder="One option per line" value=${opts} onInput=${(e) => setOpts(e.target.value)}></textarea>
      <div class="row"><button onClick=${async () => { const r = await act('poll-create', { question: q, options: opts.split('\n') }); if (r.ok) { setQ(''); setOpts(''); setAdding(false); } }}>Start poll</button><button class="ghost" onClick=${() => setAdding(false)}>Cancel</button></div></div>`}
    ${!polls.length && !adding && html`<p class="note">No polls yet.</p>`}
    ${polls.map((p) => html`<div class="poll ${p.open ? '' : 'closed'}" key=${p.id}>
      <div class="row"><b style="flex:1">${p.question}</b><span class="note">${p.open ? `${p.total} vote${p.total === 1 ? '' : 's'}` : `Closed · ${p.total} votes`}</span></div>
      ${p.options.map((o, i) => html`<button class="opt ${o.mine ? 'mine' : ''}" disabled=${!p.open} onClick=${() => act('poll-vote', { id: p.id, option: i })}>
        <span class="bar" style=${`width:${p.total ? Math.round((100 * o.votes) / p.total) : 0}%`}></span><span class="txt">${o.mine ? '✓ ' : ''}${o.text}</span><span class="n">${o.votes}</span></button>`)}
      <div class="row" style="margin-top:4px"><span class="note" style="flex:1">by ${p.by}</span>${p.mine && html`<button class="ghost sm" onClick=${() => act('poll-close', { id: p.id, open: !p.open })}>${p.open ? 'Close' : 'Reopen'}</button><button class="ghost sm" onClick=${() => confirm('Delete this poll?') && act('poll-delete', { id: p.id })}>🗑</button>`}</div>
    </div>`)}
  <//>`;
}

function Signups({ sheets }) {
  const [adding, setAdding] = useState(false);
  const [t, setT] = useState('');
  const [max, setMax] = useState('');
  return html`<${Card} title="Sign-ups" right=${!adding && html`<button class="ghost" onClick=${() => setAdding(true)}>＋ New sheet</button>`}>
    ${adding && html`<div class="form"><div class="row"><input placeholder="Karaoke 9pm, Volleyball team, Early breakfast…" value=${t} maxLength=${80} onInput=${(e) => setT(e.target.value)} /><input type="number" min="1" placeholder="Max" style="flex:0 0 80px" value=${max} onInput=${(e) => setMax(e.target.value)} /></div>
      <div class="row"><button onClick=${async () => { const r = await act('signup-create', { title: t, max: max ? Number(max) : null }); if (r.ok) { setT(''); setMax(''); setAdding(false); } }}>Create</button><button class="ghost" onClick=${() => setAdding(false)}>Cancel</button></div></div>`}
    ${!sheets.length && !adding && html`<p class="note">No sign-up sheets yet.</p>`}
    ${sheets.map((s) => html`<div class="item" key=${s.id}>
      <div class="what"><b>${s.title}</b><div class="note">${s.people.length}${s.max ? ` / ${s.max}` : ''} signed up${s.people.length ? `: ${s.people.join(', ')}` : ''}</div></div>
      <div class="row"><button class=${s.mine ? 'ghost' : ''} disabled=${!s.mine && s.max && s.people.length >= s.max} onClick=${() => act('signup-toggle', { id: s.id })}>${s.mine ? 'Leave' : s.max && s.people.length >= s.max ? 'Full' : 'Join'}</button>
        ${s.owner && html`<button class="ghost sm" onClick=${() => confirm('Delete this sheet?') && act('signup-delete', { id: s.id })}>🗑</button>`}</div>
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

// ---- People: everyone known to the host, online first, and what you can do with each ----
const deviceOf = (uid) => [...state.devices.values()].find((d) => d.uid === uid && d.chatKey); // their device, if they have the room open now
function Person({ p }) {
  const dev = p.id === me() ? null : deviceOf(p.id);
  const channels = (window.ch?.list ?? []).filter((c) => c.joined && !c.members.includes(p.id) && !['general', 'announcements'].includes(c.id));
  const dm = () => { openDm(dev.id); };
  const call = async () => { openDm(dev.id); await new Promise((r) => setTimeout(r, 100)); startCall(chats[view.chatId]); };
  return html`<div class="person">
    <div class="chat-row"><span>${p.online ? '🟢' : '⚪'}</span>
      <span class="who">${p.name}${p.id === me() ? ' (you)' : ''}${p.host ? html` <span class="pill">host</span>` : ''}<div>${p.online ? (dev ? 'in the room' : 'online') : `last seen ${new Date(p.seen).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</div></span>
      ${dev && html`<button class="ghost sm" onClick=${dm}>💬</button><button class="ghost sm" onClick=${call} title="Voice call">📞</button>`}
      ${dev && dev.caps?.includes('ring') && html`<button class="ghost sm" title="Ring their phone" onClick=${() => socket.emit('ring', { to: dev.id }, (r) => toast(r.ok ? '🔔 Ringing…' : `⚠️ ${r.error}`))}>🔔</button>`}
      ${channels.length > 0 && p.id !== me() && html`<select class="sm" style="width:auto" onChange=${(e) => { if (e.target.value) { act('channel-invite', { id: e.target.value, who: p.id }); e.target.value = ''; } }}>
        <option value="">＋ add to…</option>${channels.map((c) => html`<option value=${c.id}>${c.kind === 'public' ? '#' : '🔒'} ${c.name}</option>`)}</select>`}
    </div></div>`;
}
function People() {
  const people = Object.entries(window.ch?.people ?? {}).map(([id, p]) => ({ id, ...p })).sort((a, b) => (b.online - a.online) || (b.host - a.host) || a.name.localeCompare(b.name));
  if (!me()) return html`<${NamePrompt} />`;
  if (!people.length) return html`<${Empty} icon="👥"><p>Nobody has joined yet. Share the room's address or the Invite QR.</p><//>`;
  const here = people.filter((p) => p.online), away = people.filter((p) => !p.online);
  return html`<div class="program">
    <h3>${here.length} here now</h3>${here.map((p) => html`<${Person} p=${p} key=${p.id} />`)}
    ${away.length > 0 && html`<h3>Been here before</h3>${away.map((p) => html`<${Person} p=${p} key=${p.id} />`)}`}
    <p class="note">💬 opens a private, end-to-end encrypted chat. 📞 calls them. People show up here once they've picked a name.</p>
  </div>`;
}

// ---- Games: a scoreboard for the night and game sessions the host runs (games.js on the server) ----
const games = { data: null, open: null };
const gact = (id, action, data) => act('game-action', { id, action, data });
const playerName = (g, uid) => g.players.find((p) => p.id === uid)?.name ?? 'Someone';

function Scoreboard({ scores }) {
  return html`<${Card} title="Scoreboard" right=${amHost() && scores.length > 0 && html`<button class="ghost sm" onClick=${() => confirm('Clear all scores for the night?') && act('score-adjust', {})}>Reset</button>`}>
    ${!scores.length && html`<p class="note">No points yet. Points come from games, or the host adds them.</p>`}
    ${scores.map((s, i) => html`<div class="item" key=${s.id}><div class="when">${['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`}</div><div class="what"><b>${s.name}</b></div><div class="row"><b>${s.points}</b>
      ${amHost() && html`<button class="ghost sm" onClick=${() => act('score-adjust', { who: s.id, points: 1 })}>+1</button><button class="ghost sm" onClick=${() => act('score-adjust', { who: s.id, points: -1 })}>−1</button>`}</div></div>`)}
  <//>`;
}

function NewGame({ types }) {
  const [type, setType] = useState(types[0]?.type);
  const [title, setTitle] = useState('');
  return html`<${Card} title="Start a game">
    <div class="row">
      <select style="width:auto" value=${type} onChange=${(e) => setType(e.target.value)}>${types.map((t) => html`<option value=${t.type}>${t.icon} ${t.name}</option>`)}</select>
      <input placeholder="Title (optional)" maxLength=${60} value=${title} onInput=${(e) => setTitle(e.target.value)} />
      <button onClick=${async () => { const r = await act('game-create', { type, title }); if (r.ok) { setTitle(''); games.open = r.id; draw(); } }}>Start</button>
    </div>
    <p class="note">♟️ Chess: two seats, first to join is white. 🎲 Ludo: 2–4 seats, a 6 to leave base, captures send tokens home. 🔔 Buzzer quiz: you ask, they buzz or pick an answer, you award points. 🤔 Most likely to…: a prompt, everyone votes for someone, then the reveal.</p>
  <//>`;
}

function Quiz({ g }) {
  const s = g.state, host = g.runs, mine = me();
  const [q, setQ] = useState(''); const [opts, setOpts] = useState(''); const [ans, setAns] = useState(0); const [pts, setPts] = useState(3);
  const live = s.buzzes.find((b) => !b.judged);
  const buzzed = s.buzzes.some((b) => b.uid === mine);
  const answered = s.answers[mine] !== undefined;
  const results = s.phase === 'done' && s.options.length ? g.players.map((p) => ({ ...p, a: s.answers[p.id] })).filter((p) => p.a) : [];
  return html`<div>
    ${host && html`<div class="form">
      <input placeholder=${`Question ${s.round + 1} (or ask it out loud and leave this empty)`} value=${q} maxLength=${200} onInput=${(e) => setQ(e.target.value)} />
      <textarea rows="3" placeholder="Multiple choice? One option per line. Leave empty for buzzers." value=${opts} onInput=${(e) => setOpts(e.target.value)}></textarea>
      <div class="row">${opts.trim() && html`<label class="note">Correct:</label><select style="width:auto" value=${ans} onChange=${(e) => setAns(Number(e.target.value))}>${opts.split('\n').filter((o) => o.trim()).map((o, i) => html`<option value=${i}>${o}</option>`)}</select>`}
        <label class="note">Points:</label><select style="width:auto" value=${pts} onChange=${(e) => setPts(Number(e.target.value))}>${[1, 2, 3, 5, 10].map((n) => html`<option value=${n}>${n}</option>`)}</select>
        <button onClick=${async () => { const r = await gact(g.id, 'ask', { question: q, options: opts.split('\n'), answer: ans, points: pts }); if (r.ok) { setQ(''); setOpts(''); } }}>${s.round ? 'Next question' : 'Ask'}</button></div>
    </div>`}
    ${s.phase === 'idle' ? html`<p class="note">${host ? 'Ask the first question.' : 'Waiting for the host to ask…'}</p>` : html`<div class="qbox">
      <div class="note">Round ${s.round} · ${s.points} pts</div><h2 style="margin:4px 0 10px">${s.question}</h2>
      ${s.options.length ? html`<div class="row">${s.options.map((o, i) => html`<button class=${s.phase === 'done' && i === s.answer ? '' : 'ghost'} disabled=${host || answered || s.phase !== 'open'} onClick=${() => gact(g.id, 'answer', { option: i })}>${s.answers[mine]?.option === i ? '✓ ' : ''}${o}</button>`)}</div>
          ${!host && answered && s.phase === 'open' && html`<p class="note">Answer in. Waiting for the reveal…</p>`}
          ${host && s.phase === 'open' && html`<p class="row"><span class="note">${Object.keys(s.answers).length} of ${g.players.length} answered</span><button onClick=${() => gact(g.id, 'reveal')}>Reveal</button></p>`}
          ${results.length > 0 && html`<div class="note" style="margin-top:8px">${results.sort((a, b) => a.a.at - b.a.at).map((p) => `${p.a.option === s.answer ? '✅' : '❌'} ${p.name}`).join(' · ')}</div>`}`
      : html`${!host && html`<button class="buzz" disabled=${buzzed || s.phase !== 'open'} onClick=${() => gact(g.id, 'buzz')}>${buzzed ? 'BUZZED' : 'BUZZ'}</button>`}
          ${s.buzzes.map((b, i) => html`<div class="item" key=${b.uid}><div class="when">${i + 1}.</div><div class="what"><b>${playerName(g, b.uid)}</b> ${b.judged === 'right' ? '✅' : b.judged === 'wrong' ? '❌' : i === 0 || s.buzzes[i - 1].judged ? '👈 up' : ''}</div>
            ${host && b === live && s.phase === 'open' && html`<div class="row"><button onClick=${() => gact(g.id, 'judge', { correct: true })}>✓ Right</button><button class="ghost" onClick=${() => gact(g.id, 'judge', { correct: false })}>✗ Wrong</button></div>`}</div>`)}
          ${host && s.phase === 'open' && !s.buzzes.length && html`<p class="note">Waiting for a buzz…</p>`}
          ${host && s.phase === 'open' && s.buzzes.length > 0 && !live && html`<p class="note">Everyone who buzzed was wrong. <button class="ghost sm" onClick=${() => gact(g.id, 'reveal')}>Close round</button></p>`}`}
    </div>`}
  </div>`;
}

function Likely({ g }) {
  const s = g.state, host = g.runs, mine = me();
  const [custom, setCustom] = useState('');
  const tally = {}; for (const who of Object.values(s.votes)) tally[who] = (tally[who] ?? 0) + 1;
  const top = Math.max(0, ...Object.values(tally));
  return html`<div>
    ${host && html`<div class="row" style="margin-bottom:8px"><input placeholder="Your own prompt (optional)" value=${custom} maxLength=${140} onInput=${(e) => setCustom(e.target.value)} /><button onClick=${async () => { const r = await gact(g.id, 'next', { prompt: custom }); if (r.ok) setCustom(''); }}>${s.round ? 'Next' : 'Start'}</button></div>`}
    ${s.phase === 'idle' ? html`<p class="note">${host ? 'Start the first round.' : 'Waiting for the host…'}</p>` : html`<div class="qbox">
      <div class="note">Round ${s.round}</div><h2 style="margin:4px 0 10px">Most likely to ${s.prompt}?</h2>
      <div class="row">${g.players.map((p) => html`<button class=${s.votes[mine] === p.id ? '' : 'ghost'} disabled=${s.phase !== 'open'} onClick=${() => gact(g.id, 'vote', { who: p.id })}>${p.name}${s.phase === 'done' ? ` · ${tally[p.id] ?? 0}${tally[p.id] && tally[p.id] === top ? ' 🏆' : ''}` : ''}</button>`)}</div>
      ${s.phase === 'open' && html`<p class="row"><span class="note">${Object.keys(s.votes).length} of ${g.players.length} voted</span>${host && html`<button onClick=${() => gact(g.id, 'reveal')}>Reveal</button>`}</p>`}
    </div>`}
  </div>`;
}

// ---- Chess board: tap a piece, then a square; legal targets come from the host ----
const PIECES = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
function ChessBoard({ g }) {
  const s = g.state, mine = me();
  const [sel, setSel] = useState(null);
  const rows = s.fen.split(' ')[0].split('/').map((row) => [...row].flatMap((ch) => (/\d/.test(ch) ? Array(Number(ch)).fill('') : [ch])));
  const files = 'abcdefgh';
  const flip = s.seat === 1;
  const order = flip ? [...Array(8).keys()].reverse() : [...Array(8).keys()];
  const targets = sel ? s.legal.filter((m) => m.from === sel) : [];
  const tap = (sq, piece) => {
    const move = targets.find((m) => m.to === sq);
    if (move) { gact(g.id, 'move', { from: move.from, to: move.to, promotion: move.promotion }); setSel(null); return; }
    if (s.legal.some((m) => m.from === sq)) setSel(sq); else setSel(null);
  };
  const names = g.players.map((p) => p.name);
  const status = s.result ? (s.result.winner ? `${g.players.find((p) => p.id === s.result.winner)?.name} wins by ${s.result.how}` : `Draw by ${s.result.how}`)
    : g.players.length < 2 ? 'Waiting for a second player…' : `${s.turn === 'w' ? names[0] : names[1]} to move${s.check ? ' · check!' : ''}${s.legal.length ? ' (you)' : ''}`;
  return html`<div class="chess">
    <div class="row" style="justify-content:space-between"><span>♙ ${names[0] ?? '—'}</span><span>♟ ${names[1] ?? '—'}</span></div>
    <div class="board ${flip ? 'flip' : ''}">
      ${order.map((r) => order.map((c) => { const sq = files[c] + (8 - r); const piece = rows[r][c]; const light = (r + c) % 2 === 0; const isT = targets.some((m) => m.to === sq); const isLast = s.last && (s.last.from === sq || s.last.to === sq);
        return html`<div key=${sq} class="sq ${light ? 'light' : 'dark'} ${sel === sq ? 'sel' : ''} ${isT ? 'target' : ''} ${isLast ? 'last' : ''}" onClick=${() => tap(sq, piece)}>${piece && html`<span class=${piece === piece.toUpperCase() ? 'pw' : 'pb'}>${PIECES[piece]}</span>`}</div>`; }))}
    </div>
    <p class="row"><span class="note" style="flex:1">${status}</span>
      ${s.seat >= 0 && !s.result && g.players.length === 2 && html`<button class="ghost sm" onClick=${() => gact(g.id, 'draw')}>${s.drawOffer && s.drawOffer !== mine ? 'Accept draw' : s.drawOffer === mine ? 'Draw offered' : 'Offer draw'}</button><button class="ghost sm" onClick=${() => confirm('Resign?') && gact(g.id, 'resign')}>Resign</button>`}</p>
    ${s.moves.length > 0 && html`<p class="note" style="word-break:break-word">${s.moves.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + m).join(' ')}</p>`}
  </div>`;
}

// ---- Ludo board: the classic 15×15 cross. Tokens sit on cells; tap one of yours to move it ----
const LUDO_COLORS = ['#e04b4b', '#3fa65b', '#e6b422', '#3b7ddd'];
const LUDO_NAMES = ['Red', 'Green', 'Yellow', 'Blue'];
const LUDO_START = [0, 13, 26, 39];
const LUDO_SAFE = [0, 8, 13, 21, 26, 34, 39, 47];
const LUDO_PATH = (() => { const p = []; const push = (r, c) => p.push([r, c]);
  for (let c = 1; c <= 5; c++) push(6, c); for (let r = 5; r >= 0; r--) push(r, 6); push(0, 7); for (let r = 0; r <= 5; r++) push(r, 8); for (let c = 9; c <= 14; c++) push(6, c); push(7, 14);
  for (let c = 14; c >= 9; c--) push(8, c); for (let r = 9; r <= 14; r++) push(r, 8); push(14, 7); for (let r = 14; r >= 9; r--) push(r, 6); for (let c = 5; c >= 0; c--) push(8, c); push(7, 0); push(6, 0); return p; })();
const LUDO_HOME_COL = [[...Array(5).keys()].map((i) => [7, 1 + i]), [...Array(5).keys()].map((i) => [1 + i, 7]), [...Array(5).keys()].map((i) => [7, 13 - i]), [...Array(5).keys()].map((i) => [13 - i, 7])];
const LUDO_BASE = [[[1, 1], [1, 4], [4, 1], [4, 4]], [[1, 10], [1, 13], [4, 10], [4, 13]], [[10, 10], [10, 13], [13, 10], [13, 13]], [[10, 1], [10, 4], [13, 1], [13, 4]]];
const ludoCell = (seat, p, i) => (p === -1 ? LUDO_BASE[seat][i] : p <= 50 ? LUDO_PATH[(LUDO_START[seat] + p) % 52] : p <= 55 ? LUDO_HOME_COL[seat][p - 51] : [7, 7]);
const ludoArea = (r, c) => { // which colour a background cell belongs to
  if (r < 6 && c < 6) return 0; if (r < 6 && c > 8) return 1; if (r > 8 && c > 8) return 2; if (r > 8 && c < 6) return 3;
  if (r === 7 && c >= 1 && c <= 5) return 0; if (c === 7 && r >= 1 && r <= 5) return 1; if (r === 7 && c >= 9 && c <= 13) return 2; if (c === 7 && r >= 9 && r <= 13) return 3;
  return -1; };

function LudoBoard({ g }) {
  const s = g.state, mine = me();
  const seats = g.players.map((p, i) => ({ ...p, seat: i }));
  const tokens = []; // [{seat, i, r, c, movable}]
  for (const pl of seats) for (const [i, p] of (s.tokens[pl.id] ?? [-1, -1, -1, -1]).entries()) { const [r, c] = ludoCell(pl.seat, p, i); tokens.push({ seat: pl.seat, i, r, c, p, movable: pl.id === mine && s.movable.includes(i) }); }
  const me_ = seats.find((p) => p.id === mine);
  const turnName = g.players[s.turn]?.name;
  const status = s.result ? `${g.players.find((p) => p.id === s.result.winner)?.name} wins!` : g.players.length < 2 ? 'Waiting for more players…' : `${turnName}'s turn${s.die ? ` · rolled ${s.die}` : ''}${s.mine ? (s.phase === 'roll' ? ' · roll!' : ' · pick a token') : ''}`;
  return html`<div class="ludo">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap">${seats.map((p) => html`<span key=${p.id} style=${`color:${LUDO_COLORS[p.seat]}`}>● ${p.name}${p.seat === s.turn && !s.result ? ' ◀' : ''}</span>`)}</div>
    <div class="lboard">
      ${[...Array(15).keys()].flatMap((r) => [...Array(15).keys()].map((c) => { const a = ludoArea(r, c); const base = a >= 0 && ((r < 6 || r > 8) && (c < 6 || c > 8)); const inner = base && r >= 1 && r <= 4 && c % 15 >= 1 && (c <= 4 || c >= 10) && (c <= 4 ? c >= 1 : c <= 13) && (r <= 4) ; const idx = LUDO_PATH.findIndex(([pr, pc]) => pr === r && pc === c); const safe = idx >= 0 && LUDO_SAFE.includes(idx); const center = r >= 6 && r <= 8 && c >= 6 && c <= 8 && !(idx >= 0);
        const bg = a >= 0 ? (base ? (inner ? '#f3e9dc' : LUDO_COLORS[a]) : LUDO_COLORS[a] + 'aa') : center ? '#2a2030' : idx >= 0 ? '#f3e9dc' : '#1b1420';
        return html`<div key=${r * 15 + c} class="lc" style=${`background:${bg}`}>${safe ? html`<span class="star">★</span>` : ''}</div>`; }))}
      ${tokens.map((t) => html`<div key=${`${t.seat}-${t.i}`} class="tok ${t.movable ? 'can' : ''}" style=${`left:${(t.c + 0.5) * 100 / 15}%;top:${(t.r + 0.5) * 100 / 15}%;background:${LUDO_COLORS[t.seat]}`} onClick=${() => t.movable && gact(g.id, 'move', { token: t.i })}></div>`)}
    </div>
    <p class="row"><span class="note" style="flex:1">${status}</span>
      ${me_ && s.mine && s.phase === 'roll' && !s.result && g.players.length >= 2 && html`<button class="roll" onClick=${() => gact(g.id, 'roll')}>🎲 Roll</button>`}
      ${s.die && html`<span class="die">${['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][s.die - 1]}</span>`}</p>
    ${s.log.length > 0 && html`<p class="note">${s.log.slice(-3).join(' · ')}</p>`}
    ${!s.locked && g.players.length < 4 && html`<p class="note">Seats are open until the first roll (${g.players.length} of 4).</p>`}
  </div>`;
}

function GameView({ g }) {
  const body = g.type === 'quiz' ? html`<${Quiz} g=${g} />` : g.type === 'chess' ? html`<${ChessBoard} g=${g} />` : g.type === 'ludo' ? html`<${LudoBoard} g=${g} />` : html`<${Likely} g=${g} />`;
  return html`<${Card} title=${`${g.icon} ${g.title}`} right=${html`<div class="row"><span class="note">${g.players.length} playing</span>${g.runs && html`<button class="ghost sm" onClick=${() => confirm('End this game?') && act('game-end', { id: g.id })}>End</button>`}<button class="ghost sm" onClick=${() => { games.open = null; draw(); }}>‹ All games</button></div>`}>
    ${!g.joined && (!g.seats || g.players.length < g.seats) && html`<p><button onClick=${() => act('game-join', { id: g.id })}>${g.seats ? 'Take a seat' : 'Join this game'}</button></p>`}
    ${(g.joined || g.runs || g.seats) && body}
    <p class="note">Playing: ${g.players.map((p) => p.name).join(', ') || 'nobody yet'}</p>
  <//>`;
}

function Games() {
  if (!me()) return html`<${NamePrompt} />`;
  const d = games.data;
  if (!d) return html`<${Empty} icon="🎲"><p>Loading…</p><//>`;
  const open = d.games.find((g) => g.id === games.open && !g.ended);
  if (open) return html`<div class="program"><${GameView} g=${open} /></div>`;
  const live = d.games.filter((g) => !g.ended);
  return html`<div class="program">
    <${NewGame} types=${d.types} />
    <${Card} title="Games on now">
      ${!live.length && html`<p class="note">Nothing yet. Start one above.</p>`}
      ${live.map((g) => html`<div class="item" key=${g.id}><div class="when">${g.icon}</div><div class="what"><b>${g.title}</b><div class="note">${g.name} · ${g.players.length}${g.seats ? ` of ${g.seats} seats` : ' playing'}${g.joined ? ' · you\'re in' : ''}</div></div>
        <button onClick=${() => { games.open = g.id; draw(); }}>${g.joined ? 'Open' : g.seats && g.players.length >= g.seats ? 'Watch' : 'Open'}</button></div>`)}
    <//>
    <${Scoreboard} scores=${d.scores} />
  </div>`;
}

// ---- Files: the shared library on the host device (library.js on the server) ----
const lib = { data: null, playing: null, uploads: [] };
const fmtBytes = (n) => (n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
function uploadFiles(list) {
  for (const file of list) {
    const u = { name: file.name, size: file.size, done: 0, error: null };
    lib.uploads.push(u); draw();
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/library/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('x-wifiroom-key', myChatKey());
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { u.done = e.loaded; draw(); };
    xhr.onload = () => { if (xhr.status !== 200) { u.error = (() => { try { return JSON.parse(xhr.responseText).error; } catch { return `HTTP ${xhr.status}`; } })(); toast(`⚠️ ${file.name}: ${u.error}`); } else { lib.uploads = lib.uploads.filter((x) => x !== u); toast(`📁 ${file.name} is in Files`); } draw(); };
    xhr.onerror = () => { u.error = 'upload failed'; draw(); };
    xhr.send(file);
  }
}
function Player({ f }) {
  const src = f.url;
  return html`<div class="player">
    ${f.kind === 'video' ? html`<video src=${src} controls autoplay playsinline />` : f.kind === 'audio' ? html`<audio src=${src} controls autoplay />` : html`<img src=${src} alt=${f.name} />`}
    <div class="row" style="padding:8px"><b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${f.name}</b><a class="btn ghost" href=${`${src}?download`} download=${f.name}>⬇ Save</a><button class="ghost" onClick=${() => { lib.playing = null; draw(); }}>✕</button></div>
  </div>`;
}
function Files() {
  if (!me()) return html`<${NamePrompt} />`;
  const d = lib.data;
  if (!d) return html`<${Empty} icon="📁"><p>Loading…</p><//>`;
  const playing = d.files.find((f) => f.id === lib.playing);
  const groups = [['image', '🖼 Photos'], ['video', '🎬 Videos'], ['audio', '🎵 Music'], ['file', '📄 Other files']].map(([k, t]) => [t, d.files.filter((f) => f.kind === k)]).filter(([, l]) => l.length);
  const icon = { video: '🎬', audio: '🎵', file: '📄' };
  return html`<div class="files program">
    <div class="row" style="margin-bottom:10px">
      <label class="btn upbtn">⬆ Upload files<input type="file" multiple onChange=${(e) => { uploadFiles([...e.target.files]); e.target.value = ''; }} /></label>
      <span class="note" style="flex:1">Shared with everyone in the room, kept on the host device${d.free ? ` · ${fmtBytes(d.free)} free there` : ''}.</span>
    </div>
    <p class="warn">Files are shared as-is by people in this room; nothing checks them. Photos, music and video play here; everything else is download only. Open downloads at your own risk.</p>
    ${lib.uploads.map((u) => html`<div class="item" key=${u.name}><div class="what"><b>${u.name}</b> <span class="note">${u.error ? `⚠️ ${u.error}` : `${fmtBytes(u.done)} of ${fmtBytes(u.size)}`}</span>${!u.error && html`<progress max=${u.size} value=${u.done}></progress>`}</div></div>`)}
    ${playing && html`<${Player} f=${playing} />`}
    ${!d.files.length && html`<${Empty} icon="📁"><p>Nothing shared yet. Photos, music, a movie, notes: upload and everyone here can open it.</p><//>`}
    ${groups.map(([title, list]) => html`<${Card} title=${`${title} · ${list.length}`} key=${title}>
      ${list[0].kind === 'image' ? html`<div class="grid">${list.map((f) => html`<div class="tile" key=${f.id} onClick=${() => { lib.playing = f.id; draw(); }}><img src=${f.url} loading="lazy" alt=${f.name} /><div class="cap">${f.name}</div></div>`)}</div>`
      : list.map((f) => html`<div class="item" key=${f.id}>
          <div class="when">${icon[f.kind]}</div>
          <div class="what" style="cursor:pointer" onClick=${() => { if (f.kind !== 'file') { lib.playing = f.id; draw(); } }}><b>${f.name}</b><div class="note">${fmtBytes(f.size)} · ${f.by} · ${new Date(f.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div></div>
          <div class="row">${f.kind !== 'file' && html`<button class="ghost sm" onClick=${() => { lib.playing = f.id; draw(); }}>▶</button>`}<a class="btn ghost sm" href=${`${f.url}?download`} download=${f.name}>⬇</a>${f.mine && html`<button class="ghost sm" onClick=${() => confirm(`Remove ${f.name} for everyone?`) && act('library-delete', { id: f.id })}>🗑</button>`}</div>
        </div>`)}
    <//>`)}
  </div>`;
}

const draw = () => {
  render(html`<${Files} />`, document.getElementById('files'));
  render(html`<${Program} />`, document.getElementById('program'));
  render(html`<${People} />`, document.getElementById('people'));
  render(html`<${Games} />`, document.getElementById('games'));
};
draw();
window.addEventListener('pane', draw);
socket.on('program', (p) => { prog.data = p; draw(); });
socket.on('games', (g) => { games.data = g; draw(); });
socket.on('library', (l) => { lib.data = l; draw(); });
socket.on('channels', () => { if (window.ch?.me && !window.ch.msgs.announcements) socket.emit('channel-history', { id: 'announcements' }, (r) => { if (r.ok) { window.ch.msgs.announcements = r.messages; draw(); } }); draw(); });
socket.on('channel-msg', ({ channel }) => channel === 'announcements' && draw());
socket.on('devices', draw); // who is in the room right now, for People
setInterval(() => document.body.dataset.pane === 'program' && draw(), 60_000); // Now / Next moves with the clock
