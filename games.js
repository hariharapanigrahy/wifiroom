// Games for a game night, run by the device hosting the room (games.json): a scoreboard for the night and
// game sessions. Each game type is a small set of rules (`step`) that the host and players drive through
// actions; the host device keeps the state so everyone sees the same thing. Points go to the scoreboard.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { JSONFilePreset } from 'lowdb/node';

const id = () => randomBytes(5).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const MAX_GAMES = 30;

// ---- game types ----
// A quiz with a buzzer: the host asks (aloud, or types it), players buzz, the first buzz is locked in and the
// host marks it right (points) or wrong (the next buzz gets a turn). Or multiple choice: everyone answers,
// fastest correct answers score.
const quiz = {
  name: 'Buzzer quiz', icon: '🔔',
  create: () => ({ round: 0, question: '', options: [], answer: null, phase: 'idle', buzzes: [], answers: {}, points: 3 }),
  step(g, s, uid, action, data, host) {
    if (action === 'ask' && host) {
      const q = clean(data?.question, 200);
      const options = (Array.isArray(data?.options) ? data.options : []).map((o) => clean(o, 80)).filter(Boolean).slice(0, 6);
      Object.assign(s, { round: s.round + 1, question: q || `Question ${s.round + 1}`, options, answer: options.length && Number.isInteger(data?.answer) ? data.answer : null, phase: 'open', buzzes: [], answers: {}, points: [1, 2, 3, 5, 10].includes(data?.points) ? data.points : s.points });
      return;
    }
    if (s.phase !== 'open') return;
    if (action === 'buzz' && !host && !s.options.length) {
      if (!s.buzzes.some((b) => b.uid === uid)) s.buzzes.push({ uid, at: Date.now() });
      return;
    }
    if (action === 'answer' && !host && s.options.length && s.answers[uid] === undefined && Number.isInteger(data?.option)) {
      s.answers[uid] = { option: data.option, at: Date.now() };
      return;
    }
    if (action === 'judge' && host && s.buzzes.length) {
      // Right: the first unjudged buzz scores; wrong: it's out and the next buzz is up.
      const b = s.buzzes.find((x) => !x.judged);
      if (!b) return;
      b.judged = data?.correct ? 'right' : 'wrong';
      if (data?.correct) { g.award(b.uid, s.points); s.phase = 'done'; }
      return;
    }
    if (action === 'reveal' && host) {
      if (s.options.length && s.answer !== null) {
        const right = Object.entries(s.answers).filter(([, a]) => a.option === s.answer).sort((a, b) => a[1].at - b[1].at);
        right.forEach(([who], i) => g.award(who, i === 0 ? s.points : Math.max(1, Math.floor(s.points / 2))));
      }
      s.phase = 'done';
    }
  },
};

// "Most likely to…": a prompt, everyone votes for a person, then the reveal.
const PROMPTS = ['fall asleep first tonight', 'win an argument with a toddler', 'get lost in their own neighbourhood', 'eat the last slice without asking', 'become famous for something weird', 'cry at a commercial', 'survive a zombie apocalypse', 'forget their own birthday', 'start a band', 'text back three days late', 'order dessert first', 'talk to a stranger on a flight for 5 hours', 'befriend a stray cat', 'accidentally join a cult', 'run a marathon on a whim'];
const likely = {
  name: 'Most likely to…', icon: '🤔',
  create: () => ({ round: 0, prompt: '', phase: 'idle', votes: {}, used: [] }),
  step(g, s, uid, action, data, host) {
    if (action === 'next' && host) {
      const custom = clean(data?.prompt, 140);
      const left = PROMPTS.filter((p) => !s.used.includes(p));
      const prompt = custom || left[Math.floor(Math.random() * left.length)] || PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
      if (!custom) s.used.push(prompt);
      Object.assign(s, { round: s.round + 1, prompt, phase: 'open', votes: {} });
      return;
    }
    if (action === 'vote' && s.phase === 'open' && typeof data?.who === 'string' && g.players.includes(data.who)) { s.votes[uid] = data.who; return; }
    if (action === 'reveal' && host && s.phase === 'open') {
      const tally = {};
      for (const who of Object.values(s.votes)) tally[who] = (tally[who] ?? 0) + 1;
      const top = Math.max(0, ...Object.values(tally));
      for (const [who, n] of Object.entries(tally)) if (n === top && top > 0) g.award(who, 1);
      s.phase = 'done';
    }
  },
};

const TYPES = { quiz, likely };

export async function startGames({ dataDir, io, isHost, nameOf }) {
  const db = await JSONFilePreset(path.join(dataDir, 'games.json'), { scores: {}, games: [] });
  const D = db.data;
  let dirty = null;
  const save = () => { dirty ??= setTimeout(() => { dirty = null; db.write().catch(() => {}); }, 500); };

  const view = (g, uid) => ({ id: g.id, type: g.type, name: TYPES[g.type].name, icon: TYPES[g.type].icon, title: g.title, by: nameOf(g.by), created: g.created, ended: g.ended,
    players: g.players.map((p) => ({ id: p, name: nameOf(p) })), joined: g.players.includes(uid), state: g.state });
  const snapshot = (uid) => ({
    types: Object.entries(TYPES).map(([k, t]) => ({ type: k, name: t.name, icon: t.icon })),
    games: D.games.filter((g) => !g.ended || Date.now() - g.ended < 3600e3).map((g) => view(g, uid)),
    scores: Object.entries(D.scores).map(([who, points]) => ({ id: who, name: nameOf(who), points })).sort((a, b) => b.points - a.points),
  });
  const announce = () => { for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('games', snapshot(s.data.uid)); };

  function attach(socket) {
    const uid = () => socket.data.uid;
    const host = () => !!uid() && isHost(uid());
    const find = (gid) => D.games.find((g) => g.id === gid && !g.ended);

    socket.on('game-create', ({ type, title } = {}, ack) => {
      if (!host()) return ack?.({ ok: false, error: 'Only the host starts games' });
      if (!TYPES[type]) return ack?.({ ok: false, error: 'Unknown game' });
      const g = { id: id(), type, title: clean(title, 60) || TYPES[type].name, by: uid(), created: Date.now(), ended: null, players: [], state: TYPES[type].create() };
      D.games.unshift(g);
      D.games = D.games.slice(0, MAX_GAMES);
      save(); ack?.({ ok: true, id: g.id }); announce();
    });
    socket.on('game-join', ({ id: gid } = {}, ack) => {
      const g = find(gid);
      if (!uid() || !g) return ack?.({ ok: false, error: 'That game is over' });
      if (!g.players.includes(uid())) g.players.push(uid());
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('game-action', ({ id: gid, action, data } = {}, ack) => {
      const g = find(gid), me = uid();
      if (!me || !g) return ack?.({ ok: false, error: 'That game is over' });
      if (!g.players.includes(me) && !host()) return ack?.({ ok: false, error: 'Join the game first' });
      const api = { players: g.players, award: (who, n) => { D.scores[who] = (D.scores[who] ?? 0) + n; } };
      TYPES[g.type].step(api, g.state, me, String(action), data, host());
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('game-end', ({ id: gid } = {}, ack) => {
      if (!host()) return ack?.({ ok: false, error: 'Only the host ends games' });
      const g = find(gid);
      if (g) g.ended = Date.now();
      save(); ack?.({ ok: true }); announce();
    });
    // The host can fix the board: { who, points } adds (or subtracts) points; no who clears the night.
    socket.on('score-adjust', ({ who, points } = {}, ack) => {
      if (!host()) return ack?.({ ok: false, error: 'Only the host changes scores' });
      if (typeof who !== 'string') D.scores = {};
      else D.scores[who] = (D.scores[who] ?? 0) + (Number(points) || 0);
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('games-get', (...args) => { const ack = args.find((a) => typeof a === 'function'); if (uid()) ack?.(snapshot(uid())); });
  }

  return { attach, announce };
}
