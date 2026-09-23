// Card utilities and hand evaluation for Texas Hold'em.
// Works both in the browser (window.PokerEval) and in Node (module.exports).
(function (root) {
  'use strict';

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const HAND_NAMES = [
    'ハイカード',
    'ワンペア',
    'ツーペア',
    'スリーカード',
    'ストレート',
    'フラッシュ',
    'フルハウス',
    'フォーカード',
    'ストレートフラッシュ',
  ];
  const CATEGORY_BASE = Math.pow(15, 5);

  function rankLabel(rank) {
    return RANK_LABELS[rank] || String(rank);
  }

  function cardToString(card) {
    return rankLabel(card.rank) + SUITS[card.suit];
  }

  function createDeck() {
    const deck = [];
    for (let suit = 0; suit < 4; suit++) {
      for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
    }
    return deck;
  }

  function shuffle(deck, random = Math.random) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  // Scores exactly five cards. Higher score = stronger hand.
  function eval5(cards) {
    const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
    const flush = cards.every((c) => c.suit === cards[0].suit);
    const counts = new Map();
    for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
    // Groups ordered by size, then rank: this is also the kicker order.
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const groupRanks = groups.map((g) => g[0]);

    let straightHigh = 0;
    if (counts.size === 5) {
      if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
      else if (ranks[0] === 14 && ranks[1] === 5) straightHigh = 5; // A-2-3-4-5
    }

    let category;
    let kickers;
    if (straightHigh && flush) {
      category = 8;
      kickers = [straightHigh];
    } else if (groups[0][1] === 4) {
      category = 7;
      kickers = groupRanks;
    } else if (groups[0][1] === 3 && groups[1][1] === 2) {
      category = 6;
      kickers = groupRanks;
    } else if (flush) {
      category = 5;
      kickers = ranks;
    } else if (straightHigh) {
      category = 4;
      kickers = [straightHigh];
    } else if (groups[0][1] === 3) {
      category = 3;
      kickers = groupRanks;
    } else if (groups[0][1] === 2 && groups[1][1] === 2) {
      category = 2;
      kickers = groupRanks;
    } else if (groups[0][1] === 2) {
      category = 1;
      kickers = groupRanks;
    } else {
      category = 0;
      kickers = ranks;
    }

    let score = category;
    for (let i = 0; i < 5; i++) score = score * 15 + (kickers[i] || 0);
    return score;
  }

  // Best five-card hand out of 5-7 cards.
  function evaluate(cards) {
    if (cards.length < 5) throw new Error('evaluate needs at least 5 cards');
    let best = -1;
    let bestCards = null;
    const n = cards.length;
    for (let a = 0; a < n - 4; a++)
      for (let b = a + 1; b < n - 3; b++)
        for (let c = b + 1; c < n - 2; c++)
          for (let d = c + 1; d < n - 1; d++)
            for (let e = d + 1; e < n; e++) {
              const hand = [cards[a], cards[b], cards[c], cards[d], cards[e]];
              const score = eval5(hand);
              if (score > best) {
                best = score;
                bestCards = hand;
              }
            }
    const category = Math.floor(best / CATEGORY_BASE);
    return { score: best, category, name: HAND_NAMES[category], cards: bestCards };
  }

  function sameCard(a, b) {
    return a.rank === b.rank && a.suit === b.suit;
  }

  // Monte Carlo estimate of the chance that `hole` wins against
  // `opponents` random hands, given the current `board`. Ties count
  // as a fractional win.
  function estimateEquity(hole, board, opponents, iterations = 300, random = Math.random) {
    if (opponents <= 0) return 1;
    const known = hole.concat(board);
    const remaining = createDeck().filter((c) => !known.some((k) => sameCard(k, c)));
    const needBoard = 5 - board.length;
    let total = 0;

    for (let it = 0; it < iterations; it++) {
      // Partial shuffle: only draw as many cards as needed.
      const draw = needBoard + opponents * 2;
      for (let i = 0; i < draw; i++) {
        const j = i + Math.floor(random() * (remaining.length - i));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
      const fullBoard = board.concat(remaining.slice(0, needBoard));
      const myScore = evaluate(hole.concat(fullBoard)).score;
      let bestOpp = -1;
      let ties = 0;
      for (let o = 0; o < opponents; o++) {
        const start = needBoard + o * 2;
        const oppScore = evaluate(remaining.slice(start, start + 2).concat(fullBoard)).score;
        if (oppScore > bestOpp) {
          bestOpp = oppScore;
          ties = 0;
        }
        if (oppScore === bestOpp) ties++;
      }
      if (myScore > bestOpp) total += 1;
      else if (myScore === bestOpp) total += 1 / (ties + 1);
    }
    return total / iterations;
  }

  const api = {
    SUITS,
    HAND_NAMES,
    rankLabel,
    cardToString,
    createDeck,
    shuffle,
    eval5,
    evaluate,
    estimateEquity,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerEval = api;
})(typeof window !== 'undefined' ? window : globalThis);
