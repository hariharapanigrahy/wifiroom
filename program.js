// The program: what's happening at this gathering, kept on the device hosting the room (program.json).
// A title ("Game night", "Beach resort · Oct 5"), a schedule with Now/Next, polls, and sign-up sheets.
// Announcements are a channel only the host can post in (#announcements, see channels.js).
// The host (the organizer, whoever runs the room) edits; everyone sees, votes and signs up.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { JSONFilePreset } from 'lowdb/node';

const MAX_ITEMS = 200;
const id = () => randomBytes(5).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const when = (t) => (Number.isFinite(t) && t > 0 ? Math.round(t) : null);

export async function startProgram({ dataDir, io, isHost, nameOf, say }) {
  const db = await JSONFilePreset(path.join(dataDir, 'program.json'), { title: '', schedule: [], polls: [], signups: [] });
  const P = db.data;
  let dirty = null;
  const save = () => { dirty ??= setTimeout(() => { dirty = null; db.write().catch(() => {}); }, 500); };

  // What everyone sees. Votes stay on the host: each person gets the counts plus their own choice.
  const snapshot = (uid) => ({
    title: P.title,
    schedule: [...P.schedule].sort((a, b) => a.start - b.start).map((i) => ({ ...i, alerts: undefined, mine: i.by === uid || isHost(uid), byName: nameOf(i.by), going: (i.going ?? []).map(nameOf), goingMe: (i.going ?? []).includes(uid) })),
    polls: P.polls.map((p) => ({ id: p.id, question: p.question, open: p.open, closes: p.closes ?? null, ts: p.ts, by: nameOf(p.by), mine: p.by === uid || isHost(uid), total: p.options.reduce((n, o) => n + o.votes.length, 0),
      options: p.options.map((o) => ({ text: o.text, votes: o.votes.length, mine: o.votes.includes(uid) })) })),
    signups: P.signups.map((s) => ({ id: s.id, title: s.title, max: s.max, people: s.people.map(nameOf), mine: s.people.includes(uid), by: nameOf(s.by), owner: s.by === uid || isHost(uid) })),
  });
  const announce = () => { for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('program', snapshot(s.data.uid)); };
  const place = (i) => (i.where ? ` · ${i.where}` : '');

  // Alerts: ten minutes before something starts, and when it starts, everyone gets a nudge and
  // #announcements gets a line. Polls with a closing time close themselves.
  const SOON = 10 * 60_000;
  const alert = (kind, item, text) => {
    (item.alerts ??= []).push(kind);
    say('announcements', text);
    for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('program-alert', { kind, id: item.id, title: item.title, where: item.where, start: item.start, text });
  };
  const tick = () => {
    const now = Date.now();
    let changed = false;
    for (const i of P.schedule) {
      const left = i.start - now;
      if (left > 0 && left <= SOON && !i.alerts?.includes('soon')) { alert('soon', i, `⏰ ${i.title} starts in ${Math.max(1, Math.round(left / 60_000))} min${place(i)}`); changed = true; }
      if (left <= 0 && left > -2 * 60_000 && !i.alerts?.includes('now')) { alert('now', i, `▶️ ${i.title} is starting now${place(i)}`); changed = true; }
    }
    for (const p of P.polls) if (p.open && p.closes && p.closes <= now) { p.open = false; say('general', `🗳️ Poll closed: ${p.question}`); changed = true; }
    if (changed) { save(); announce(); }
  };
  const timer = setInterval(tick, 20_000);
  timer.unref?.();

  function attach(socket) {
    const uid = () => socket.data.uid;
    const host = () => !!uid() && isHost(uid());
    const deny = (ack) => ack?.({ ok: false, error: 'Only the host can change the program' });
    const signedIn = (ack) => uid() || (ack?.({ ok: false, error: 'Pick a name first' }), false);
    const owns = (item) => host() || item?.by === uid(); // edits and deletions: the person who added it, or the host
    socket.on('program-clear', (ack) => {
      if (!host()) return deny(ack);
      Object.assign(P, { title: '', schedule: [], polls: [], signups: [] });
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('program-get', (...args) => { const ack = args.find((a) => typeof a === 'function'); if (uid()) ack?.(snapshot(uid())); });

    socket.on('program-title', ({ title } = {}, ack) => {
      if (!host()) return deny(ack);
      P.title = clean(title, 80);
      save(); ack?.({ ok: true }); announce();
    });

    // Schedule items: { id?, title, start, end?, where?, notes? }; with an id, it's an edit.
    socket.on('schedule-save', (item = {}, ack) => {
      if (!signedIn(ack)) return;
      const title = clean(item.title, 80), start = when(item.start);
      if (!title || !start) return ack?.({ ok: false, error: 'A title and a start time are needed' });
      const old = typeof item.id === 'string' ? P.schedule.find((x) => x.id === item.id) : null;
      if (old && !owns(old)) return ack?.({ ok: false, error: 'Only whoever added this, or the host, can change it' });
      const it = { id: old ? old.id : id(), title, start, end: when(item.end), where: clean(item.where, 60), notes: clean(item.notes, 300), by: old ? old.by : uid(), going: old?.going ?? [], alerts: old && old.start === start ? old.alerts : [] };
      const i = P.schedule.findIndex((x) => x.id === it.id);
      i >= 0 ? (P.schedule[i] = it) : P.schedule.push(it);
      if (P.schedule.length > MAX_ITEMS) P.schedule.shift();
      save(); ack?.({ ok: true, id: it.id }); announce();
    });
    socket.on('schedule-delete', ({ id: sid } = {}, ack) => {
      if (!owns(P.schedule.find((x) => x.id === sid))) return deny(ack);
      P.schedule = P.schedule.filter((x) => x.id !== sid);
      save(); ack?.({ ok: true }); announce();
    });

    // "I'm in": who plans to be there.
    socket.on('schedule-rsvp', ({ id: sid, going } = {}, ack) => {
      const me = uid(), it = P.schedule.find((x) => x.id === sid);
      if (!me || !it) return ack?.({ ok: false, error: 'No such item' });
      it.going = (it.going ?? []).filter((p) => p !== me);
      if (going) it.going.push(me);
      save(); ack?.({ ok: true }); announce();
    });
    // Put an item in #announcements, as whoever announces it.
    socket.on('schedule-announce', ({ id: sid } = {}, ack) => {
      const it = P.schedule.find((x) => x.id === sid);
      if (!it || !owns(it)) return deny(ack);
      const d = new Date(it.start);
      const today = d.toDateString() === new Date().toDateString();
      const when = `${today ? '' : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} `}${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      say('announcements', `📅 ${it.title} · ${when}${place(it)}${it.notes ? ` · ${it.notes}` : ''}`, uid());
      ack?.({ ok: true });
    });

    socket.on('poll-create', ({ question, options, closes } = {}, ack) => {
      if (!signedIn(ack)) return;
      const q = clean(question, 140);
      const opts = (Array.isArray(options) ? options : []).map((o) => clean(o, 60)).filter(Boolean).slice(0, 8);
      if (!q || opts.length < 2) return ack?.({ ok: false, error: 'A question and at least two options' });
      const closeAt = when(closes);
      if (closeAt && closeAt <= Date.now()) return ack?.({ ok: false, error: 'The closing time has already passed' });
      P.polls.unshift({ id: id(), question: q, options: opts.map((text) => ({ text, votes: [] })), open: true, closes: closeAt, ts: Date.now(), by: uid() });
      P.polls = P.polls.slice(0, 50);
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('poll-vote', ({ id: pid, option } = {}, ack) => {
      const me = uid(), p = P.polls.find((x) => x.id === pid);
      if (!me || !p || !p.open || !p.options[option]) return ack?.({ ok: false, error: 'This poll is closed' });
      for (const o of p.options) o.votes = o.votes.filter((v) => v !== me);
      p.options[option].votes.push(me);
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('poll-close', ({ id: pid, open } = {}, ack) => {
      const p = P.polls.find((x) => x.id === pid);
      if (!owns(p)) return deny(ack);
      if (p) p.open = !!open;
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('poll-delete', ({ id: pid } = {}, ack) => {
      if (!owns(P.polls.find((x) => x.id === pid))) return deny(ack);
      P.polls = P.polls.filter((x) => x.id !== pid);
      save(); ack?.({ ok: true }); announce();
    });

    // Sign-up sheets: "Karaoke slot 9pm (max 6)".
    socket.on('signup-create', ({ title, max } = {}, ack) => {
      if (!signedIn(ack)) return;
      const t = clean(title, 80);
      if (!t) return ack?.({ ok: false, error: 'Give it a title' });
      P.signups.unshift({ id: id(), title: t, max: Number.isInteger(max) && max > 0 ? Math.min(max, 500) : null, people: [], by: uid() });
      P.signups = P.signups.slice(0, 50);
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('signup-toggle', ({ id: sid } = {}, ack) => {
      const me = uid(), s = P.signups.find((x) => x.id === sid);
      if (!me || !s) return ack?.({ ok: false, error: 'No such sheet' });
      if (s.people.includes(me)) s.people = s.people.filter((p) => p !== me);
      else if (s.max && s.people.length >= s.max) return ack?.({ ok: false, error: 'Full' });
      else s.people.push(me);
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('signup-delete', ({ id: sid } = {}, ack) => {
      if (!owns(P.signups.find((x) => x.id === sid))) return deny(ack);
      P.signups = P.signups.filter((x) => x.id !== sid);
      save(); ack?.({ ok: true }); announce();
    });
  }

  return { attach, announce };
}
