const test = require('node:test');
const assert = require('node:assert');
const Eval = require('../js/evaluator.js');
const { PokerGame } = require('../js/engine.js');

const SUIT = { s: 0, h: 1, d: 2, c: 3 };
const RANK = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
const cards = (str) =>
  str.split(' ').map((c) => ({ rank: RANK[c[0]] || Number(c[0]), suit: SUIT[c[1]] }));
const best = (str) => Eval.evaluate(cards(str));

test('recognises every hand category', () => {
  assert.strictEqual(best('As Ks Qs Js Ts 2d 3c').name, 'ストレートフラッシュ');
  assert.strictEqual(best('9s 9h 9d 9c 2s 3d 4c').name, 'フォーカード');
  assert.strictEqual(best('9s 9h 9d 2c 2s 3d 4c').name, 'フルハウス');
  assert.strictEqual(best('2h 5h 9h Jh Kh 3d 4c').name, 'フラッシュ');
  assert.strictEqual(best('Ah 2d 3c 4s 5h 9d Kc').name, 'ストレート');
  assert.strictEqual(best('7h 7d 7c 2s 5h 9d Kc').name, 'スリーカード');
  assert.strictEqual(best('7h 7d 5c 5s 2h 9d Kc').name, 'ツーペア');
  assert.strictEqual(best('7h 7d 4c 5s 2h 9d Kc').name, 'ワンペア');
  assert.strictEqual(best('7h 3d 4c 5s 2h 9d Kc').name, 'ハイカード');
});

test('compares hands correctly', () => {
  assert.ok(best('Ah 2d 3c 4s 5h').score < best('2h 3d 4c 5s 6h').score, 'wheel is lowest straight');
  assert.ok(best('Ah Ad Kc 5s 2h').score > best('Ah Ad Qc 5s 2h').score, 'kicker');
  assert.ok(best('Kh Kd 2c 2s 3h').score > best('Qh Qd Jc Js Ah').score, 'two pair high pair');
  assert.ok(best('3h 3d 3c 2s 2h').score > best('Ah Kh 9h 5h 2h').score, 'boat beats flush');
  assert.strictEqual(best('Ah Kd Qc Js 9h').score, best('As Kc Qd Jh 9c').score, 'tie');
});

test('equity estimate is sensible', () => {
  const trips = Eval.estimateEquity(cards('As Ah Ad 7c 2h'), [3, 4], 1, 2000);
  const junk = Eval.estimateEquity(cards('Ks 9h 7d 4c 2s'), [1, 2, 3, 4], 1, 2000);
  assert.ok(trips > 0.8, `trip aces strong: ${trips}`);
  assert.ok(junk < 0.4, `king high weak: ${junk}`);
});

test('CPU discards follow draw-poker basics', () => {
  const pick = (str) => Eval.chooseDiscards(cards(str)).sort();
  assert.deepStrictEqual(pick('2h 5h 9h Jh Kh'), [], 'pat flush');
  assert.deepStrictEqual(pick('7h 7d 5c 5s Kh'), [4], 'two pair keeps both pairs');
  assert.deepStrictEqual(pick('7h 7d 4c 5s Kh'), [2, 3, 4], 'one pair draws three');
  assert.deepStrictEqual(pick('2h 5h 9h Jh Kc'), [4], 'four to a flush');
  assert.deepStrictEqual(pick('9c Th Jd Qs 3h'), [4], 'four to a straight');
  assert.deepStrictEqual(pick('Ac 9h 7d 4s 2h'), [1, 2, 3, 4], 'keep the ace');
});

test('exchange replaces exactly the chosen cards', () => {
  const game = new PokerGame({ names: ['A', 'B'], humanIndex: -1 });
  game.startHand();
  const p = game.players[0];
  const kept = p.hand.slice(2);
  const deckBefore = game.deck.length;
  game.exchange(p, [0, 1]);
  assert.strictEqual(p.hand.length, 5);
  assert.strictEqual(p.drew, 2);
  assert.strictEqual(game.deck.length, deckBefore - 2);
  for (const c of kept) assert.ok(p.hand.includes(c));
});

test('side pots are built from contributions', () => {
  const game = new PokerGame({ names: ['A', 'B', 'C'], humanIndex: -1 });
  const [a, b, c] = game.players;
  a.totalBet = 50; b.totalBet = 200; c.totalBet = 200;
  let pots = game.buildPots();
  assert.deepStrictEqual(pots.map((p) => p.amount), [150, 300]);
  assert.deepStrictEqual(pots[1].eligible, [b, c]);
  c.folded = true;
  pots = game.buildPots();
  assert.deepStrictEqual(pots.map((p) => p.amount), [150, 300]);
  assert.deepStrictEqual(pots[1].eligible, [b]);
});

test('full CPU-only games conserve chips and finish', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    let s = seed;
    const random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const game = new PokerGame({ names: ['A', 'B', 'C', 'D'], humanIndex: -1, random, equityIterations: 40 });
    const total = game.players.reduce((t, p) => t + p.chips, 0);
    let hands = 0;
    while (!game.isGameOver() && hands < 500) {
      await game.playHand();
      hands++;
      const sum = game.players.reduce((t, p) => t + p.chips, 0);
      assert.strictEqual(sum, total, `chips conserved (seed ${seed}, hand ${hands})`);
      assert.ok(game.players.every((p) => p.chips >= 0));
    }
    assert.ok(game.isGameOver(), `game ${seed} ended within 500 hands`);
  }
});

test('all hands are revealed when everyone else folds', async () => {
  let checked = 0;
  for (let seed = 1; seed <= 40 && checked < 5; seed++) {
    let s = seed;
    const random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const game = new PokerGame({ names: ['A', 'B', 'C', 'D'], humanIndex: -1, random, equityIterations: 40 });
    for (let h = 0; h < 30 && !game.isGameOver(); h++) {
      await game.playHand();
      const dealt = game.players.filter((p) => p.hand.length === 5);
      if (dealt.filter((p) => !p.folded).length === 1) {
        for (const p of dealt) {
          assert.ok(p.showCards, `${p.name} revealed`);
          assert.ok(p.result, `${p.name} has a hand name`);
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'saw at least one hand won by folds');
});

test('dealing is uniformly random (chi-square)', () => {
  const { runChecks } = require('../scripts/check-randomness.js');
  const { results, duplicates } = runChecks(20000);
  assert.strictEqual(duplicates, 0);
  // A fair deck fails any single check at this level about once in 10,000 runs.
  for (const r of results) assert.ok(r.p > 1e-4, `${r.name}: p=${r.p}`);
});
