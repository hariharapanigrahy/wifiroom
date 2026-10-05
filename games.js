// Games for a game night, run by the device hosting the room (games.json): a scoreboard for the night and
// game sessions. Each game type is a small set of rules (`step`) that the host and players drive through
// actions; the host device keeps the state so everyone sees the same thing. Points go to the scoreboard.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { JSONFilePreset } from 'lowdb/node';
import { Chess } from 'chess.js';

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

// ---- Chess: two seats (first to join is white), rules by chess.js. The state is the move list; the
// position is replayed from it, so threefold repetition and the like come for free.
const chess = {
  name: 'Chess', icon: '♟️', min: 2, max: 2,
  create: () => ({ moves: [], result: null, drawOffer: null, resigned: null }),
  game(s) { const c = new Chess(); for (const m of s.moves) c.move(m); return c; },
  step(g, s, uid, action, data) {
    if (s.result) return;
    const seat = g.players.indexOf(uid);
    if (seat < 0 || seat > 1) return;
    const c = chess.game(s);
    const color = seat === 0 ? 'w' : 'b';
    if (action === 'move' && c.turn() === color) {
      const m = (() => { try { return c.move({ from: String(data?.from), to: String(data?.to), promotion: data?.promotion || 'q' }); } catch { return null; } })();
      if (!m) return;
      s.moves.push(m.san);
      s.drawOffer = null;
      if (c.isCheckmate()) s.result = { winner: uid, how: 'checkmate' };
      else if (c.isDraw()) s.result = { winner: null, how: c.isStalemate() ? 'stalemate' : c.isThreefoldRepetition() ? 'repetition' : c.isInsufficientMaterial() ? 'insufficient material' : '50-move rule' };
      if (s.result?.winner) g.award(s.result.winner, 3);
      return;
    }
    if (action === 'resign') { s.result = { winner: g.players[1 - seat], how: 'resignation' }; g.award(s.result.winner, 3); return; }
    if (action === 'draw') {
      if (s.drawOffer && s.drawOffer !== uid) s.result = { winner: null, how: 'agreement' };
      else s.drawOffer = uid;
    }
  },
  // Each player sees the position, whose move it is, and (on their turn) their legal moves.
  view(s, uid, g) {
    const c = chess.game(s);
    const seat = g.players.indexOf(uid);
    const turn = c.turn();
    const mine = (seat === 0 && turn === 'w') || (seat === 1 && turn === 'b');
    const last = c.history({ verbose: true }).at(-1);
    return { fen: c.fen(), turn, seat, check: c.inCheck(), moves: s.moves, last: last ? { from: last.from, to: last.to } : null, result: s.result, drawOffer: s.drawOffer,
      legal: mine && !s.result ? c.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, promotion: m.promotion })) : [] };
  },
};

// ---- Ludo: 2–4 seats, four tokens each. Positions are relative to a player's own start: -1 in base,
// 0–50 on the track, 51–55 the home column, 56 home. Seat 0 is red, then green, yellow, blue.
const LUDO = { START: [0, 13, 26, 39], SAFE: [0, 8, 13, 21, 26, 34, 39, 47], HOME: 56 };
const ludo = {
  name: 'Ludo', icon: '🎲', min: 2, max: 4,
  create: () => ({ turn: 0, die: null, phase: 'roll', tokens: {}, locked: false, result: null, log: [], sixes: 0 }),
  abs: (seat, p) => (LUDO.START[seat] + p) % 52,
  movable(g, s, uid, die) {
    const seat = g.players.indexOf(uid), t = s.tokens[uid];
    return t.map((p, i) => ({ p, i })).filter(({ p }) => (p === -1 ? die === 6 : p + die <= LUDO.HOME)).map(({ i }) => i);
  },
  step(g, s, uid, action, data) {
    if (s.result) return;
    for (const p of g.players) s.tokens[p] ??= [-1, -1, -1, -1];
    const seat = g.players.indexOf(uid);
    if (seat < 0 || seat !== s.turn) return;
    const next = () => { s.turn = (s.turn + 1) % g.players.length; s.die = null; s.phase = 'roll'; s.sixes = 0; };
    if (action === 'roll' && s.phase === 'roll') {
      s.locked = true;
      s.die = 1 + Math.floor(Math.random() * 6);
      s.phase = 'move';
      const can = ludo.movable(g, s, uid, s.die);
      if (!can.length) { s.log.push(`${g.names[uid]} rolled ${s.die}, no move`); next(); return; }
      if (can.length === 1) ludo.step(g, s, uid, 'move', { token: can[0] });
      return;
    }
    if (action === 'move' && s.phase === 'move' && Number.isInteger(data?.token)) {
      const i = data.token, t = s.tokens[uid];
      if (!ludo.movable(g, s, uid, s.die).includes(i)) return;
      const from = t[i];
      t[i] = from === -1 ? 0 : from + s.die;
      let again = s.die === 6;
      if (t[i] <= 50) {
        const at = ludo.abs(seat, t[i]);
        if (!LUDO.SAFE.includes(at)) for (const other of g.players) {
          if (other === uid) continue;
          const os = g.players.indexOf(other);
          s.tokens[other].forEach((op, oi) => { if (op >= 0 && op <= 50 && ludo.abs(os, op) === at) { s.tokens[other][oi] = -1; again = true; s.log.push(`${g.names[uid]} captured ${g.names[other]}`); } });
        }
      }
      if (t[i] === LUDO.HOME) { again = true; s.log.push(`${g.names[uid]} got a token home`); }
      if (t.every((p) => p === LUDO.HOME)) { s.result = { winner: uid }; s.phase = 'done'; s.die = null; g.award(uid, 3); s.log.push(`${g.names[uid]} wins!`); return; }
      s.log = s.log.slice(-6);
      if (again) { s.sixes = s.die === 6 ? s.sixes + 1 : 0; s.die = null; s.phase = 'roll'; if (s.sixes >= 3) next(); } else next();
    }
  },
  view(s, uid, g) {
    const seat = g.players.indexOf(uid);
    return { ...s, seat, mine: seat === s.turn, movable: seat === s.turn && s.phase === 'move' && s.tokens[uid] ? ludo.movable(g, s, uid, s.die) : [] };
  },
};

// ---- Crazy Eights: 2–6 seats, hidden hands. Match the top card's suit or rank; an 8 goes on anything and
// names the next suit. No playable card: draw one (play it if it fits). First to empty their hand wins.
const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const deck = () => { const d = []; for (const s of SUITS) for (const r of RANKS) d.push(r + s); for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; } return d; };
const rankOf = (c) => c.slice(0, -1), suitOf = (c) => c.slice(-1);
const eights = {
  name: 'Crazy Eights', icon: '🃏', min: 2, max: 6,
  create: () => ({ started: false, hands: {}, pile: [], draw: [], suit: null, turn: 0, result: null, log: [], drew: false, locked: false }),
  fits: (s, c) => rankOf(c) === '8' || suitOf(c) === s.suit || rankOf(c) === rankOf(s.pile.at(-1)),
  step(g, s, uid, action, data) {
    if (s.result) return;
    const seat = g.players.indexOf(uid);
    if (action === 'deal' && !s.started && seat >= 0 && g.players.length >= 2) {
      s.draw = deck(); s.pile = []; s.hands = {};
      for (const p of g.players) s.hands[p] = s.draw.splice(0, g.players.length > 4 ? 5 : 7);
      do { s.pile.push(s.draw.shift()); } while (rankOf(s.pile.at(-1)) === '8'); // the first card up isn't an 8
      s.suit = suitOf(s.pile.at(-1)); s.turn = 0; s.started = true; s.locked = true; s.drew = false;
      s.log = [`${g.names[g.players[0]]} starts`];
      return;
    }
    if (!s.started || seat !== s.turn) return;
    const hand = s.hands[uid];
    const next = () => { s.turn = (s.turn + 1) % g.players.length; s.drew = false; };
    if (action === 'play' && typeof data?.card === 'string' && hand.includes(data.card) && eights.fits(s, data.card)) {
      hand.splice(hand.indexOf(data.card), 1);
      s.pile.push(data.card);
      s.suit = rankOf(data.card) === '8' && SUITS.includes(data?.suit) ? data.suit : suitOf(data.card);
      s.log.push(`${g.names[uid]} played ${data.card}${rankOf(data.card) === '8' ? ` → ${s.suit}` : ''}`);
      if (!hand.length) { s.result = { winner: uid }; g.award(uid, 2); s.log.push(`${g.names[uid]} wins!`); return; }
      if (hand.length === 1) s.log.push(`${g.names[uid]} has one card left`);
      s.log = s.log.slice(-6);
      next();
      return;
    }
    if (action === 'draw' && !s.drew) {
      if (!s.draw.length) { const top = s.pile.pop(); s.draw = s.pile.splice(0); s.pile = [top]; for (let i = s.draw.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s.draw[i], s.draw[j]] = [s.draw[j], s.draw[i]]; } }
      if (!s.draw.length) { s.log.push(`${g.names[uid]} can't draw, passes`); next(); return; }
      const c = s.draw.shift();
      hand.push(c); s.drew = true;
      s.log.push(`${g.names[uid]} drew a card`);
      if (!eights.fits(s, c)) next(); // nothing to play: the turn passes
      return;
    }
    if (action === 'pass' && s.drew) { next(); }
  },
  // You see your own hand; others' hands are just counts.
  view(s, uid, g) {
    const seat = g.players.indexOf(uid);
    const mine = s.hands[uid] ?? [];
    return { started: s.started, seat, turn: s.turn, mine: seat === s.turn && !s.result, hand: mine, playable: seat === s.turn && !s.result ? mine.filter((c) => eights.fits(s, c)) : [], top: s.pile.at(-1) ?? null, suit: s.suit, drawLeft: s.draw.length, drew: s.drew,
      counts: Object.fromEntries(g.players.map((p) => [p, s.hands[p]?.length ?? 0])), result: s.result, log: s.log.slice(-4), locked: s.locked };
  },
};

const TYPES = { chess, ludo, eights, quiz, likely };

export async function startGames({ dataDir, io, isHost, nameOf }) {
  const db = await JSONFilePreset(path.join(dataDir, 'games.json'), { scores: {}, games: [] });
  const D = db.data;
  let dirty = null;
  const save = () => { dirty ??= setTimeout(() => { dirty = null; db.write().catch(() => {}); }, 500); };

  const view = (g, uid) => ({ id: g.id, type: g.type, name: TYPES[g.type].name, icon: TYPES[g.type].icon, title: g.title, by: nameOf(g.by), byId: g.by, runs: g.by === uid || isHost(uid), created: g.created, ended: g.ended,
    players: g.players.map((p) => ({ id: p, name: nameOf(p) })), joined: g.players.includes(uid), seats: TYPES[g.type].max ?? null,
    state: TYPES[g.type].view ? TYPES[g.type].view(g.state, uid, g) : g.state });
  const snapshot = (uid) => ({
    types: Object.entries(TYPES).map(([k, t]) => ({ type: k, name: t.name, icon: t.icon, players: t.max ? `${t.min}–${t.max}` : 'any' })),
    games: D.games.filter((g) => !g.ended || Date.now() - g.ended < 3600e3).map((g) => view(g, uid)),
    scores: Object.entries(D.scores).map(([who, points]) => ({ id: who, name: nameOf(who), points })).sort((a, b) => b.points - a.points),
  });
  const announce = () => { for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('games', snapshot(s.data.uid)); };

  function attach(socket) {
    const uid = () => socket.data.uid;
    const host = () => !!uid() && isHost(uid());
    const find = (gid) => D.games.find((g) => g.id === gid && !g.ended);

    // Anyone can start a game; whoever starts it runs it (asks, judges, ends), as can the room's host.
    const runs = (g) => host() || g.by === uid();
    socket.on('game-create', ({ type, title } = {}, ack) => {
      if (!uid()) return ack?.({ ok: false, error: 'Pick a name first' });
      if (!TYPES[type]) return ack?.({ ok: false, error: 'Unknown game' });
      const g = { id: id(), type, title: clean(title, 60) || TYPES[type].name, by: uid(), created: Date.now(), ended: null, players: [], state: TYPES[type].create() };
      D.games.unshift(g);
      D.games = D.games.slice(0, MAX_GAMES);
      save(); ack?.({ ok: true, id: g.id }); announce();
    });
    socket.on('game-join', ({ id: gid } = {}, ack) => {
      const g = find(gid);
      if (!uid() || !g) return ack?.({ ok: false, error: 'That game is over' });
      const max = TYPES[g.type].max;
      if (!g.players.includes(uid())) {
        if (max && g.players.length >= max) return ack?.({ ok: false, error: 'All seats are taken' });
        if (g.state.locked) return ack?.({ ok: false, error: 'This game has started' });
        g.players.push(uid());
      }
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('game-action', ({ id: gid, action, data } = {}, ack) => {
      const g = find(gid), me = uid();
      if (!me || !g) return ack?.({ ok: false, error: 'That game is over' });
      if (!g.players.includes(me) && !host()) return ack?.({ ok: false, error: 'Join the game first' });
      if (TYPES[g.type].min && g.players.length < TYPES[g.type].min) return ack?.({ ok: false, error: `Needs ${TYPES[g.type].min} players` });
      const api = { players: g.players, names: Object.fromEntries(g.players.map((p) => [p, nameOf(p)])), award: (who, n) => { D.scores[who] = (D.scores[who] ?? 0) + n; } };
      TYPES[g.type].step(api, g.state, me, String(action), data, runs(g));
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('game-end', ({ id: gid } = {}, ack) => {
      const g = find(gid);
      if (!g || !runs(g)) return ack?.({ ok: false, error: 'Only whoever started the game, or the host, can end it' });
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
export { TYPES }; // for tests
