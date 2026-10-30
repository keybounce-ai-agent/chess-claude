/* Achronal Chess engine v0.2 - headless, deterministic, integer energy.
   Chess legality comes from chess.js. Players: 0 = White (even plies), 1 = Black (odd plies). */
(function (root) {
'use strict';
const Chess = (typeof require === 'function' && typeof module !== 'undefined') ? require('./chess.js').Chess : root.Chess;
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const STEPS = 3; // WAVE_STEPS_PER_TURN: fixed constant [D]
const DEFAULTS = { regen: [100, 100], start: [0, 100], max: [600, 700], costPerTurn: 100, transferEdit: 0, transferResp: 0 }; // ENERGY_SCALE 100

const load = f => { const c = new Chess(); c.load(f); return c; };
const legal = f => load(f).moves({ verbose: true }).map(m => m.promotion ? { from: m.from, to: m.to, promotion: m.promotion } : { from: m.from, to: m.to });
const same = (a, b) => !!a && !!b && a.from === b.from && a.to === b.to && (a.promotion || '') === (b.promotion || '');
const isLegal = (f, m) => !!m && legal(f).some(x => same(x, m));
const apply = (f, m) => { const c = load(f); return c.move({ from: m.from, to: m.to, promotion: m.promotion }) ? c.fen() : null; };
const infoCache = new Map();
function info(f) {
  if (infoCache.has(f)) return infoCache.get(f);
  const c = load(f); let k = null;
  if (!c.moves().length) k = c.in_check() ? 'checkmate' : 'stalemate';
  else if (c.insufficient_material()) k = 'insufficient';
  else if (+f.split(' ')[4] >= 100) k = 'fifty_move';
  infoCache.set(f, k); return k;
}
const tipOf = g => g.states.length - 1;
const cost = (g, j) => Math.ceil((tipOf(g) - j) / 2) * g.cfg.costPerTurn;
const err = e => ({ ok: false, err: e });
const ev = (g, s) => { g.events.push(s); };
const name = p => (p ? 'Black' : 'White');

function newGame(cfg) {
  const g = { cfg: Object.assign({}, DEFAULTS, cfg), states: [{ fen: START, move: null }], waves: [], owed: [], marks: [], events: [], log: [],
    n: 0, actor: 0, edited: false, frozen: false, extra: false, passes: 0, interrupt: null, q: null, mode: 'turn', over: null, wid: 1 };
  g.energy = g.cfg.start.slice();
  startTurn(g); return g;
}
function startTurn(g) {
  g.energy[g.actor] = Math.min(g.cfg.max[g.actor], g.energy[g.actor] + g.cfg.regen[g.actor]);
  g.edited = false; g.passes = 0;
}
function pay(g, p, amt, pct) {
  const t = Math.floor(amt * pct / 100);
  g.energy[p] -= amt; g.energy[p ^ 1] = Math.min(g.cfg.max[p ^ 1], g.energy[p ^ 1] + t);
}
function recomputeMarks(g) {
  const seen = new Map(); g.marks = [];
  g.states.forEach((s, i) => {
    const key = s.fen.split(' ').slice(0, 4).join(' '), c = (seen.get(key) || 0) + 1; seen.set(key, c);
    const k = info(s.fen) || (c >= 3 ? 'threefold' : null);
    if (k) g.marks.push({ index: i, kind: k });
  });
}
function canEdit(g, p, limit) {
  for (let j = p; j < limit; j += 2) {
    if (g.owed.includes(j) || cost(g, j) > g.energy[p]) continue;
    if (legal(g.states[j].fen).some(m => !same(m, g.states[j].move))) return true;
  }
  return false;
}
const earlierWave = (g, idx) => g.waves.some(w => w.front < idx);

/* ---- wave resolution ---- */
function begin(g, mode) {
  g.mode = mode;
  g.waves.forEach(w => { if (w.halted && legal(g.states[w.front].fen).length) w.halted = false; });
  g.q = g.waves.filter(w => !w.halted).sort((a, b) => b.front - a.front).map(w => ({ w, steps: STEPS }));
  run(g);
}
function run(g) {
  const tip = tipOf(g);
  while (g.q.length) {
    const e = g.q[0], w = e.w;
    while (e.steps > 0 && w.front < tip) {
      if (g.owed.includes(w.front)) { e.steps = 0; break; }
      const nf = apply(g.states[w.front].fen, g.states[w.front].move);
      if (!nf) { e.steps = 0; break; }
      g.states[w.front + 1].fen = nf; w.front++; e.steps--;
      if (w.front >= tip) break;
      const st = g.states[w.front];
      if (!legal(st.fen).length) { w.halted = true; e.steps = 0; break; }
      if (!isLegal(st.fen, st.move)) {
        if (e.steps > 0) { g.interrupt = { index: w.front, actor: w.front % 2 }; ev(g, `Wave ${w.id} invalidated ply ${w.front}: ${name(w.front % 2)} must answer now (interrupt)`); return; }
        g.owed.push(w.front); ev(g, `Wave ${w.id} invalidated ply ${w.front}: ${name(w.front % 2)} owes a response next turn`); e.steps = 0; break;
      }
    }
    if (w.front >= tip) { g.waves = g.waves.filter(x => x !== w); ev(g, `Wave ${w.id} reached the present`); }
    g.q.shift();
  }
  finish(g);
}
function finish(g) {
  g.q = null;
  if (g.mode === 'turn') g.n = tipOf(g);
  g.actor ^= 1; g.edited = false;
  settle(g);
}
function settle(g) {
  recomputeMarks(g);
  if (g.marks.length) {
    if (!g.frozen) ev(g, `FREEZE: ${g.marks[0].kind} at ply ${g.marks[0].index}; the present stops`);
    g.frozen = true; g.extra = false; checkFinal(g); return;
  }
  if (g.frozen && g.actor !== g.n % 2 && !g.extra) { g.extra = true; ev(g, 'Freeze lifting: one extra tick to restore parity'); return; }
  if (g.frozen) ev(g, 'Freeze lifted');
  g.frozen = false; g.extra = false; startTurn(g);
}
function checkFinal(g) {
  const m = g.marks[0], owner = m.index % 2, wait = earlierWave(g, m.index);
  if (m.kind === 'checkmate') {
    if (!wait && !canEdit(g, owner, m.index)) { g.over = { kind: 'checkmate', index: m.index, winner: owner ^ 1 }; ev(g, `Checkmate at ply ${m.index}: ${name(owner ^ 1)} wins`); }
  } else if (g.passes >= 2 && !wait) { g.over = { kind: m.kind, index: m.index, winner: null }; ev(g, `Draw (${m.kind}) at ply ${m.index}`); }
}

/* ---- actions ---- */
function guard(g, p) {
  if (g.over) return err('ERR_GAME_OVER');
  if (g.interrupt) return p === g.interrupt.actor ? null : err('ERR_NOT_YOUR_TURN');
  return p === g.actor ? null : err('ERR_NOT_YOUR_TURN');
}
function edit(g, p, j, m) {
  let e = guard(g, p); if (e) return e;
  if (g.interrupt) return err('ERR_RESPONSES_OWED');
  const tip = tipOf(g);
  if (g.extra && false) return err('ERR_ILLEGAL_MOVE');
  if (j % 2 !== p) return err('ERR_NOT_YOUR_PLY');
  if (j < 0 || j >= tip) return err('ERR_ILLEGAL_MOVE');
  if (g.frozen && j >= g.marks[0].index) return err('ERR_EDIT_AT_OR_AFTER_FROZEN');
  if (g.owed.includes(j)) return err('ERR_EDIT_PENDING_INDEX');
  if (g.edited) return err('ERR_EDIT_LIMIT');
  if (!isLegal(g.states[j].fen, m) || same(m, g.states[j].move)) return err('ERR_ILLEGAL_MOVE');
  const c = cost(g, j); if (g.energy[p] < c) return err('ERR_INSUFFICIENT_ENERGY');
  pay(g, p, c, g.cfg.transferEdit);
  g.states[j].move = m; g.edited = true; g.passes = 0;
  g.waves.push({ id: g.wid++, origin: j, front: j, halted: false });
  g.log.push({ a: 'edit', p, j, m }); ev(g, `${name(p)} edits ply ${j} (cost ${c / 100})`);
  if (g.frozen) begin(g, 'tick');
  return { ok: true };
}
function present(g, p, m) {
  let e = guard(g, p); if (e) return e;
  if (g.interrupt) return err('ERR_RESPONSES_OWED');
  if (g.frozen) return err('ERR_FROZEN');
  if (g.owed.some(j => j % 2 === p)) return err('ERR_RESPONSES_OWED');
  const s = g.states[g.n];
  if (!isLegal(s.fen, m)) return err('ERR_ILLEGAL_MOVE');
  s.move = m; g.states.push({ fen: apply(s.fen, m), move: null });
  g.log.push({ a: 'present', p, m });
  begin(g, 'turn'); return { ok: true };
}
function respond(g, p, j, m) {
  let e = guard(g, p); if (e) return e;
  const forced = g.interrupt && g.interrupt.index === j;
  if (!forced && !(g.owed.includes(j) && j % 2 === p)) return err('ERR_ILLEGAL_MOVE');
  const s = g.states[j];
  if (!isLegal(s.fen, m) || same(m, s.move)) return err('ERR_ILLEGAL_MOVE');
  const c = Math.min(g.energy[p], cost(g, j));
  pay(g, p, c, g.cfg.transferResp);
  s.move = m; g.log.push({ a: 'respond', p, j, m }); ev(g, `${name(p)} answers ply ${j} (paid ${c / 100})`);
  if (forced) { g.interrupt = null; run(g); } else g.owed = g.owed.filter(x => x !== j);
  return { ok: true };
}
function pass(g, p) {
  let e = guard(g, p); if (e) return e;
  if (!g.frozen) return err('ERR_PASS_NOT_ALLOWED');
  if (g.interrupt || g.owed.some(j => j % 2 === p)) return err('ERR_PASS_NOT_ALLOWED');
  const m = g.marks[0];
  if (m && m.kind === 'checkmate' && p === m.index % 2 && canEdit(g, p, m.index) && !earlierWave(g, m.index)) return err('ERR_PASS_NOT_ALLOWED');
  g.passes++; g.log.push({ a: 'pass', p }); ev(g, `${name(p)} passes`);
  begin(g, 'tick'); return { ok: true };
}

/* ---- read-only views ---- */
const at = (fen, sq) => fen.split(' ')[0].split('/')[8 - sq[1]].replace(/\d/g, d => '.'.repeat(+d))[sq.charCodeAt(0) - 97];
function ghost(fen, m, orig) { // geometric move ignoring legality [A]; a move whose piece is gone does nothing
  const rows = fen.split(' ')[0].split('/').map(r => r.replace(/\d/g, d => '.'.repeat(+d)).split(''));
  const pos = sq => [8 - sq[1], sq.charCodeAt(0) - 97];
  const [fr, fc] = pos(m.from), [tr, tc] = pos(m.to), pc = rows[fr][fc];
  if (pc === '.' || (orig && orig !== '.' && pc !== orig)) return { fen, noop: true };
  rows[fr][fc] = '.'; rows[tr][tc] = m.promotion ? (pc === pc.toUpperCase() ? m.promotion.toUpperCase() : m.promotion) : pc;
  return { fen: rows.map(r => r.join('').replace(/\.+/g, d => d.length)).join('/') + ' w - - 0 1', noop: false };
}
function projected(g, i) { // {fen, approx, noops}: position once all waves not yet at i have arrived
  const fronts = g.waves.filter(w => w.front < i).map(w => w.front);
  if (!fronts.length) return { fen: g.states[i].fen, approx: false, noops: [] };
  let f = Math.min(...fronts), fen = g.states[f].fen, approx = false; const noops = [];
  for (let j = f; j < i; j++) {
    const m = g.states[j].move;
    if (!approx && isLegal(fen, m)) fen = apply(fen, m);
    else if (m) { approx = true; const r = ghost(fen, m, at(g.states[j].fen, m.from)); fen = r.fen; if (r.noop) noops.push(j); }
    else approx = true;
  }
  return { fen, approx, noops };
}
function replay(cfg, log) {
  const g = newGame(cfg);
  for (const x of log) (x.a === 'edit' ? edit(g, x.p, x.j, x.m) : x.a === 'present' ? present(g, x.p, x.m) : x.a === 'respond' ? respond(g, x.p, x.j, x.m) : pass(g, x.p));
  return g;
}

root.Achronal = { newGame, edit, present, respond, pass, cost, legal, isLegal, same, projected, replay, canEdit, START, DEFAULTS, STEPS };
if (typeof module !== 'undefined') module.exports = root.Achronal;
})(typeof window !== 'undefined' ? window : globalThis);
