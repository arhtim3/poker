// Statistical check that dealing is uniformly random.
// Runs the game's own dealing code many times and applies chi-square tests.
//
//   node scripts/check-randomness.js [deals]
//
// A p-value is the chance of seeing a deviation at least this large from a
// perfectly fair deck. Values are spread evenly over 0..1 for a fair deck;
// only a tiny value (e.g. < 0.001) would indicate a problem.
'use strict';

const Eval = require('../js/evaluator.js');
const { PokerGame } = require('../js/engine.js');

// ---- statistics -------------------------------------------------------------

function normalCdf(z) {
  // Abramowitz & Stegun 7.1.26 approximation of erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Upper-tail p-value of a chi-square statistic (Wilson-Hilferty).
function chiSquareP(x, df) {
  const k = df;
  const z = (Math.pow(x / k, 1 / 3) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k));
  return 1 - normalCdf(z);
}

function chiSquare(observed, expected) {
  let x = 0;
  for (let i = 0; i < observed.length; i++) x += (observed[i] - expected[i]) ** 2 / expected[i];
  return { x, df: observed.length - 1, p: chiSquareP(x, observed.length - 1) };
}

const cardIndex = (c) => c.suit * 13 + (c.rank - 2);

// Exact number of 5-card hands per category, out of C(52,5) = 2,598,960.
const CATEGORY_COUNTS = [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40];
const TOTAL_HANDS = 2598960;

// ---- checks -----------------------------------------------------------------

function runChecks(deals = 200000) {
  const results = [];

  // 1. Fisher-Yates itself: all 24 orderings of 4 items equally likely.
  {
    const perms = new Map();
    const n = deals;
    for (let i = 0; i < n; i++) {
      const key = Eval.shuffle([0, 1, 2, 3]).join('');
      perms.set(key, (perms.get(key) || 0) + 1);
    }
    const observed = [...perms.values()];
    while (observed.length < 24) observed.push(0);
    results.push({ name: '並べ方の偏り (4枚の全24通り)', ...chiSquare(observed, Array(24).fill(n / 24)) });
  }

  // Deal full hands through the game engine.
  const game = new PokerGame({ names: ['あなた', 'CPU 1', 'CPU 2', 'CPU 3'], humanIndex: 0 });
  const seatCounts = game.players.map(() => Array(52).fill(0));
  const categories = Array(9).fill(0);
  const drawCounts = Array(52).fill(0);
  let draws = 0;
  let duplicates = 0;

  for (let d = 0; d < deals; d++) {
    game.players.forEach((p) => (p.chips = 1000)); // nobody busts
    game.startHand();
    const seen = new Set();
    game.players.forEach((p, i) => {
      for (const c of p.hand) {
        seatCounts[i][cardIndex(c)]++;
        if (seen.has(cardIndex(c))) duplicates++;
        seen.add(cardIndex(c));
      }
    });
    categories[Eval.evaluate(game.players[0].hand).category]++;

    // Exchange all five cards of seat 0 and record the replacements.
    const human = game.players[0];
    game.exchange(human, [0, 1, 2, 3, 4]);
    for (const c of human.hand) {
      if (seen.has(cardIndex(c))) duplicates++;
      drawCounts[cardIndex(c)]++;
      draws++;
    }
  }

  // 2. Each seat receives every card equally often.
  game.players.forEach((p, i) => {
    results.push({
      name: `${p.name} に配られるカード (52種)`,
      ...chiSquare(seatCounts[i], Array(52).fill((deals * 5) / 52)),
    });
  });

  // 3. Hand categories match the exact probabilities of a fair deck.
  results.push({
    name: '役の出る割合 (理論値との比較)',
    ...chiSquare(
      categories,
      CATEGORY_COUNTS.map((c) => (deals * c) / TOTAL_HANDS)
    ),
    detail: categories.map((c, i) => ({
      hand: Eval.HAND_NAMES[i],
      observed: (c / deals) * 100,
      expected: (CATEGORY_COUNTS[i] / TOTAL_HANDS) * 100,
    })),
  });

  // 4. Exchanged cards come uniformly from the rest of the deck.
  results.push({ name: '交換で引くカード (52種)', ...chiSquare(drawCounts, Array(52).fill(draws / 52)) });

  return { deals, results, duplicates };
}

module.exports = { runChecks, chiSquare, chiSquareP };

if (require.main === module) {
  const deals = Number(process.argv[2]) || 200000;
  const { results, duplicates } = runChecks(deals);
  console.log(`${deals.toLocaleString()} ハンドを配って検査しました\n`);
  for (const r of results) {
    const verdict = r.p < 0.001 ? '偏りあり?' : 'OK';
    console.log(`${verdict.padEnd(6)} p=${r.p.toFixed(3)}  χ²=${r.x.toFixed(1)} (自由度 ${r.df})  ${r.name}`);
    if (r.detail) {
      for (const d of r.detail) {
        console.log(`         ${d.hand.padEnd(10, '　')} 実測 ${d.observed.toFixed(3).padStart(7)}%   理論 ${d.expected.toFixed(3).padStart(7)}%`);
      }
    }
  }
  console.log(`\n同じカードが2枚配られた回数: ${duplicates}`);
}
