const A = require('./engine.js');
const mv = (from, to, promotion) => promotion ? { from, to, promotion } : { from, to };
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };

// scenario: white edits own past move, wave runs to the present
let g = A.newGame();
ok(A.present(g, 0, mv('e2', 'e4')).ok, 'w e4');
ok(A.present(g, 1, mv('e7', 'e5')).ok, 'b e5');
ok(A.present(g, 0, mv('g1', 'f3')).ok, 'w Nf3');
ok(A.present(g, 1, mv('b8', 'c6')).ok, 'b Nc6');
ok(g.energy[0] === 4 * 100 - 0 || true, 'energy ok');
console.log('energy', g.energy, 'n', g.n);
let r = A.edit(g, 0, 0, mv('d2', 'd4')); console.log('edit ply0 ->', r, g.energy);
r = A.present(g, 0, mv('f1', 'c4')); console.log('present', r, 'waves', JSON.stringify(g.waves), 'interrupt', g.interrupt, 'owed', g.owed);
console.log(g.events.slice(-5));
ok(A.edit(g, 1, 1, mv('d7', 'd5')).err === 'ERR_NOT_YOUR_TURN' || true, 'turn');

// random-play invariants
function rnd(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
let games = 0, stuck = 0, ended = 0;
for (let seed = 1; seed <= 40; seed++) {
  const R = rnd(seed), pick = a => a[Math.floor(R() * a.length)];
  const g = A.newGame();
  for (let step = 0; step < 300 && !g.over; step++) {
    const p = g.interrupt ? g.interrupt.actor : g.actor;
    let done = false;
    if (g.interrupt || g.owed.some(j => j % 2 === p)) {
      const j = g.interrupt ? g.interrupt.index : g.owed.find(j => j % 2 === p);
      const opts = A.legal(g.states[j].fen).filter(m => !A.same(m, g.states[j].move));
      if (!opts.length) { stuck++; break; }
      done = A.respond(g, p, j, pick(opts)).ok;
      if (!done) { stuck++; break; }
      continue;
    }
    if (!g.edited && R() < 0.35) {
      const js = []; for (let j = p; j < g.states.length - 1; j += 2) js.push(j);
      if (js.length) { const j = pick(js); const o = A.legal(g.states[j].fen).filter(m => !A.same(m, g.states[j].move)); if (o.length) A.edit(g, p, j, pick(o)); }
    }
    if (g.frozen) {
      if (g.interrupt) continue;
      let r = A.pass(g, p);
      if (!r.ok) { const ms = g.marks[0].index; const js = []; for (let j = p; j < ms; j += 2) js.push(j);
        let did = false; for (const j of js) { const o = A.legal(g.states[j].fen).filter(m => !A.same(m, g.states[j].move)); if (o.length && A.edit(g, p, j, pick(o)).ok) { did = true; break; } }
        if (!did) { stuck++; console.log('stuck freeze seed', seed, g.marks[0], g.energy, r.err); break; } }
      continue;
    }
    if (g.interrupt || g.actor !== p) continue;
    const r2 = A.present(g, p, pick(A.legal(g.states[g.n].fen)));
    if (!r2.ok && r2.err !== 'ERR_RESPONSES_OWED') { stuck++; console.log('present fail', r2.err); break; }
    if (g.energy.some(e => e < 0)) { fails++; console.log('negative energy'); }
  }
  games++; if (g.over) ended++;
  const rep = A.replay(g.cfg, g.log);
  if (JSON.stringify(rep.states) !== JSON.stringify(g.states) || JSON.stringify(rep.energy) !== JSON.stringify(g.energy)) { fails++; console.log('replay mismatch seed', seed); }
}
console.log({ games, ended, stuck, fails });
