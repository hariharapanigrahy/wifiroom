// Games for a game night, run by the device hosting the room (games.json): a scoreboard for the night and
// game sessions. Each game type is a small set of rules (`step`) that the host and players drive through
// actions; the host device keeps the state so everyone sees the same thing. Points go to the scoreboard.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { JSONFilePreset } from 'lowdb/node';
import { Chess } from 'chess.js';
import { createRequire } from 'node:module';
const { Hand } = createRequire(import.meta.url)('pokersolver');

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

// ---- Texas Hold'em: 2–8 seats, chips (1000 each to start), blinds 10/20, a dealer button that moves, four
// betting streets, all-ins with side pots, showdown by pokersolver. Each player sees their own hole cards;
// everyone's are shown at a showdown. A hand is dealt by anyone seated once the previous one is over.
const PDECK = () => { const d = []; for (const s of 'shdc') for (const r of '23456789TJQKA') d.push(r + s); for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; } return d; };
const holdem = {
  name: "Texas Hold'em", icon: '🂡', min: 2, max: 8, SB: 10, BB: 20, STACK: 1000,
  create: () => ({ started: false, locked: false, chips: {}, dealer: -1, hand: 0, phase: 'idle', deck: [], community: [], hole: {}, bets: {}, committed: {}, folded: {}, allin: {}, acted: {}, turn: null, currentBet: 0, minRaise: 20, result: null, log: [], out: {} }),
  seats(g, s) { return g.players.filter((p) => (s.chips[p] ?? holdem.STACK) > 0); },
  live(g, s) { return g.players.filter((p) => s.hole[p] && !s.folded[p]); },
  canAct(g, s) { return holdem.live(g, s).filter((p) => !s.allin[p]); },
  nextFrom(g, s, i) { // next seat after index i that can still act
    const n = g.players.length;
    for (let k = 1; k <= n; k++) { const j = (i + k) % n; const p = g.players[j]; if (s.hole[p] && !s.folded[p] && !s.allin[p]) return j; }
    return null;
  },
  put(s, uid, amount) { const a = Math.min(amount, s.chips[uid]); s.chips[uid] -= a; s.bets[uid] = (s.bets[uid] ?? 0) + a; s.committed[uid] = (s.committed[uid] ?? 0) + a; if (s.chips[uid] === 0) s.allin[uid] = true; return a; },
  step(g, s, uid, action, data) {
    const seat = g.players.indexOf(uid);
    if (seat < 0) return;
    if (action === 'deal' && ['idle', 'done'].includes(s.phase)) {
      for (const p of g.players) s.chips[p] ??= holdem.STACK;
      const seated = holdem.seats(g, s);
      if (seated.length < 2) return;
      s.locked = true; s.started = true; s.hand++; s.result = null;
      Object.assign(s, { deck: PDECK(), community: [], hole: {}, bets: {}, committed: {}, folded: {}, allin: {}, acted: {}, currentBet: 0, minRaise: holdem.BB });
      for (const p of seated) s.hole[p] = [s.deck.pop(), s.deck.pop()];
      // the button moves to the next seated player; blinds follow it (heads-up: the button posts the small blind)
      const n = g.players.length;
      do { s.dealer = (s.dealer + 1) % n; } while (!s.hole[g.players[s.dealer]]);
      const order = []; for (let k = 1; k <= n; k++) { const p = g.players[(s.dealer + k) % n]; if (s.hole[p]) order.push(p); }
      const sbP = seated.length === 2 ? g.players[s.dealer] : order[0], bbP = seated.length === 2 ? order[0] : order[1];
      holdem.put(s, sbP, holdem.SB); holdem.put(s, bbP, holdem.BB);
      s.currentBet = holdem.BB; s.phase = 'preflop';
      s.turn = holdem.nextFrom(g, s, g.players.indexOf(bbP));
      s.log = [`Hand ${s.hand}: ${g.names[sbP]} small blind, ${g.names[bbP]} big blind`];
      if (s.turn === null) holdem.settle(g, s);
      return;
    }
    if (action === 'act' && s.turn === seat && ['preflop', 'flop', 'turn', 'river'].includes(s.phase)) {
      const toCall = s.currentBet - (s.bets[uid] ?? 0);
      const move = String(data?.move);
      if (move === 'fold') { s.folded[uid] = true; s.log.push(`${g.names[uid]} folds`); }
      else if (move === 'check') { if (toCall > 0) return; s.log.push(`${g.names[uid]} checks`); }
      else if (move === 'call') { if (toCall <= 0) return; const a = holdem.put(s, uid, toCall); s.log.push(`${g.names[uid]} calls ${a}${s.allin[uid] ? ' (all in)' : ''}`); }
      else if (move === 'raise' || move === 'allin') {
        const to = move === 'allin' ? (s.bets[uid] ?? 0) + s.chips[uid] : Number(data?.to);
        const raiseBy = to - s.currentBet;
        if (!(to > s.currentBet) || !Number.isFinite(to)) return;
        if (raiseBy < s.minRaise && to < (s.bets[uid] ?? 0) + s.chips[uid]) return; // too small, unless it's all the chips
        holdem.put(s, uid, to - (s.bets[uid] ?? 0));
        const newBet = s.bets[uid];
        if (newBet > s.currentBet) { if (newBet - s.currentBet >= s.minRaise) s.minRaise = newBet - s.currentBet; s.currentBet = newBet; for (const p of g.players) if (p !== uid) delete s.acted[p]; }
        s.log.push(`${g.names[uid]} ${s.allin[uid] ? 'is all in for' : 'raises to'} ${newBet}`);
      } else return;
      s.acted[uid] = true;
      s.log = s.log.slice(-8);
      if (holdem.live(g, s).length === 1) return holdem.settle(g, s);
      // next to act: someone live, not all in, who hasn't acted since the last raise
      const next = (() => { const n = g.players.length; for (let k = 1; k <= n; k++) { const j = (seat + k) % n; const p = g.players[j]; if (s.hole[p] && !s.folded[p] && !s.allin[p] && !s.acted[p]) return j; } return null; })();
      if (next !== null) { s.turn = next; return; }
      holdem.nextStreet(g, s);
    }
  },
  nextStreet(g, s) {
    s.bets = {}; s.acted = {}; s.currentBet = 0; s.minRaise = holdem.BB;
    const canAct = holdem.canAct(g, s);
    const deal = (n) => { for (let i = 0; i < n; i++) s.community.push(s.deck.pop()); };
    if (s.phase === 'preflop') { deal(3); s.phase = 'flop'; }
    else if (s.phase === 'flop') { deal(1); s.phase = 'turn'; }
    else if (s.phase === 'turn') { deal(1); s.phase = 'river'; }
    else return holdem.settle(g, s);
    if (canAct.length < 2) return holdem.nextStreet(g, s); // everyone's all in: run it out
    s.turn = holdem.nextFrom(g, s, s.dealer);
  },
  settle(g, s) {
    while (s.community.length < 5 && holdem.live(g, s).length > 1) s.community.push(s.deck.pop());
    const live = holdem.live(g, s);
    const won = {}; const names = {};
    if (live.length === 1) { const total = Object.values(s.committed).reduce((a, b) => a + b, 0); won[live[0]] = total; }
    else {
      const solved = Object.fromEntries(live.map((p) => [p, Hand.solve([...s.hole[p], ...s.community])]));
      for (const p of live) names[p] = solved[p].descr;
      const levels = [...new Set(Object.values(s.committed))].sort((a, b) => a - b);
      let prev = 0;
      for (const level of levels) {
        const amount = Object.values(s.committed).reduce((sum, c) => sum + Math.max(0, Math.min(c, level) - prev), 0);
        const eligible = live.filter((p) => s.committed[p] >= level);
        if (amount > 0 && eligible.length) {
          const best = Hand.winners(eligible.map((p) => solved[p]));
          const winners = eligible.filter((p) => best.includes(solved[p]));
          const share = Math.floor(amount / winners.length); let rest = amount - share * winners.length;
          for (const w of winners) { won[w] = (won[w] ?? 0) + share + (rest > 0 ? 1 : 0); if (rest > 0) rest--; }
        }
        prev = level;
      }
    }
    for (const [p, a] of Object.entries(won)) { s.chips[p] += a; g.award(p, 1); }
    s.result = { won, names, shown: live.length > 1 ? Object.fromEntries(live.map((p) => [p, s.hole[p]])) : {}, community: s.community };
    s.log.push(`${Object.entries(won).map(([p, a]) => `${g.names[p]} wins ${a}${names[p] ? ` with ${names[p]}` : ''}`).join(', ')}`);
    s.phase = 'done'; s.turn = null;
    for (const p of g.players) if (s.chips[p] === 0) s.out[p] = true;
  },
  view(s, uid, g) {
    const seat = g.players.indexOf(uid);
    const toCall = s.turn === seat ? s.currentBet - (s.bets[uid] ?? 0) : 0;
    const chips = s.chips[uid] ?? 0;
    return { started: s.started, locked: s.locked, phase: s.phase, hand: s.hand, seat, turn: s.turn, dealer: s.dealer, community: s.community, hole: s.hole[uid] ?? null,
      pot: Object.values(s.committed).reduce((a, b) => a + b, 0), currentBet: s.currentBet, minRaise: s.minRaise, toCall, mine: s.turn === seat && ['preflop', 'flop', 'turn', 'river'].includes(s.phase),
      canCheck: toCall === 0, maxTo: (s.bets[uid] ?? 0) + chips, minTo: s.currentBet + s.minRaise,
      players: g.players.map((p, i) => ({ id: p, chips: s.chips[p] ?? holdem.STACK, bet: s.bets[p] ?? 0, folded: !!s.folded[p], allin: !!s.allin[p], inHand: !!s.hole[p], dealer: i === s.dealer, out: !!s.out[p] })),
      result: s.result, log: s.log.slice(-5) };
  },
};

const TYPES = { chess, ludo, eights, holdem, quiz, likely };

export async function startGames({ dataDir, io, isHost, nameOf, say }) {
  const db = await JSONFilePreset(path.join(dataDir, 'games.json'), { scores: {}, games: [] });
  const D = db.data;
  let dirty = null;
  const save = () => { dirty ??= setTimeout(() => { dirty = null; db.write().catch(() => {}); }, 500); };

  const view = (g, uid) => ({ id: g.id, type: g.type, name: TYPES[g.type].name, icon: TYPES[g.type].icon, title: g.title, by: nameOf(g.by), byId: g.by, runs: g.by === uid || isHost(uid), canEnd: g.players.includes(uid) || g.by === uid, created: g.created, ended: g.ended, next: g.next ?? null,
    players: g.players.map((p) => ({ id: p, name: nameOf(p) })), joined: g.players.includes(uid), seats: TYPES[g.type].max ?? null,
    state: TYPES[g.type].view ? TYPES[g.type].view(g.state, uid, g) : g.state });
  const snapshot = (uid) => ({
    types: Object.entries(TYPES).map(([k, t]) => ({ type: k, name: t.name, icon: t.icon, players: t.max ? `${t.min}–${t.max}` : 'any' })),
    games: D.games.filter((g) => !g.ended || Date.now() - g.ended < 3600e3).map((g) => view(g, uid)),
    scores: Object.entries(D.scores).map(([who, points]) => ({ id: who, name: nameOf(who), points })).sort((a, b) => b.points - a.points),
  });
  const announce = () => { for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('games', snapshot(s.data.uid)); };
  // Game news goes to #general and, as a nudge, to everyone but the person it's about.
  const notice = (text, except) => { say('general', text); for (const s of io.sockets.sockets.values()) if (s.data.uid && s.data.uid !== except) s.emit('game-notice', { text }); };
  const label = (g) => `${TYPES[g.type].icon} ${g.title}${g.title === TYPES[g.type].name ? '' : ` (${TYPES[g.type].name})`}`;
  const result = (g) => {
    const r = g.state?.result; if (!r) return null;
    const how = r.how ? ` by ${r.how}` : '';
    return r.winner ? `🏆 ${nameOf(r.winner)} won ${label(g)}${how}` : `🤝 ${label(g)} ended in a draw${how}`;
  };

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
      const t = TYPES[type];
      notice(`${label(g)}: ${nameOf(uid())} is starting a game${t.max ? ` · ${t.min}–${t.max} seats` : ''}. Open Games to join.`, uid());
      save(); ack?.({ ok: true, id: g.id }); announce();
    });
    // Same game again, for the same people (seats in reverse order, so chess colours swap).
    socket.on('game-rematch', ({ id: gid } = {}, ack) => {
      const g = D.games.find((x) => x.id === gid), me = uid();
      if (!g || !me || !g.players.includes(me)) return ack?.({ ok: false, error: 'Only the players can ask for a rematch' });
      if (g.next) return ack?.({ ok: true, id: g.next });
      if (!g.ended && !g.state?.result) return ack?.({ ok: false, error: 'This game is still on' });
      const n = { id: id(), type: g.type, title: g.title, by: g.by, created: Date.now(), ended: null, players: [...g.players].reverse(), state: TYPES[g.type].create() };
      g.next = n.id; g.ended ??= Date.now();
      D.games.unshift(n);
      D.games = D.games.slice(0, MAX_GAMES);
      notice(`🔁 ${label(g)}: ${nameOf(me)} wants a rematch with ${g.players.filter((p) => p !== me).map(nameOf).join(', ')}.`, me);
      save(); ack?.({ ok: true, id: n.id }); announce();
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
      const had = !!g.state?.result;
      TYPES[g.type].step(api, g.state, me, String(action), data, runs(g));
      if (!had && g.state?.result) notice(result(g));
      save(); ack?.({ ok: true }); announce();
    });
    // Only the people in a game end it: its players, or whoever started it (the quizmaster). Not the host.
    socket.on('game-end', ({ id: gid } = {}, ack) => {
      const g = find(gid), me = uid();
      if (!g || !me || !(g.players.includes(me) || g.by === me)) return ack?.({ ok: false, error: 'Only the people in this game can end it' });
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
    // Host clean-up: end every game, or wipe the night's games and scores.
    socket.on('games-clear', ({ scores } = {}, ack) => {
      if (!host()) return ack?.({ ok: false, error: 'Only the host' });
      for (const g of D.games) g.ended ??= Date.now();
      D.games = [];
      if (scores) D.scores = {};
      save(); ack?.({ ok: true }); announce();
    });
    socket.on('games-get', (...args) => { const ack = args.find((a) => typeof a === 'function'); if (uid()) ack?.(snapshot(uid())); });
  }

  return { attach, announce };
}
export { TYPES }; // for tests
