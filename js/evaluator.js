// Card utilities and hand evaluation for five-card draw poker.
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

  // Uniform float in [0, 1) with 53 random bits from the platform's
  // cryptographic RNG (crypto.getRandomValues), which is available in
  // browsers and Node. Falls back to Math.random only if it is missing.
  const cryptoSource =
    typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues
      ? globalThis.crypto
      : null;
  const randomWords = new Uint32Array(2);
  function secureRandom() {
    if (!cryptoSource) return Math.random();
    cryptoSource.getRandomValues(randomWords);
    return (randomWords[0] * 2 ** 21 + (randomWords[1] >>> 11)) / 2 ** 53;
  }

  // Fisher-Yates: every ordering of the deck is equally likely.
  function shuffle(deck, random = secureRandom) {
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

  // Best five-card hand out of 5 or more cards.
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

  // Which cards (indices into `hand`) a sensible player throws away in
  // five-card draw.
  function chooseDiscards(hand) {
    const { category } = evaluate(hand);
    // Straight, flush, full house, straight flush: stand pat.
    if (category >= 4 && category !== 7) return [];

    const counts = new Map();
    for (const c of hand) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
    // Pairs, trips, two pair, quads: keep the matched cards.
    if (category >= 1) return hand.map((c, i) => i).filter((i) => counts.get(hand[i].rank) === 1);

    // Four to a flush.
    for (let suit = 0; suit < 4; suit++) {
      const off = hand.map((c, i) => i).filter((i) => hand[i].suit !== suit);
      if (off.length === 1) return off;
    }

    // Four to a straight (ace counts high or low).
    for (let low = 1; low <= 10; low++) {
      const inWindow = (r) => (r >= low && r <= low + 4) || (low === 1 && r === 14);
      const out = hand.map((c, i) => i).filter((i) => !inWindow(hand[i].rank));
      if (out.length === 1) return out;
    }

    // Nothing: keep the highest card.
    let best = 0;
    hand.forEach((c, i) => {
      if (c.rank > hand[best].rank) best = i;
    });
    return hand.map((c, i) => i).filter((i) => i !== best);
  }

  function replaceCards(hand, discards, deck) {
    const kept = hand.filter((c, i) => !discards.includes(i));
    return kept.concat(deck.splice(0, discards.length));
  }

  // Monte Carlo estimate of the chance that `hand` wins against
  // `opponents` players holding random hands who draw sensibly.
  // `discards`: the cards this player will throw away (none after the draw).
  // `dead`: cards known to be out of the deck (e.g. our own discards).
  // Ties count as a fractional win.
  function estimateEquity(hand, discards, opponents, iterations = 300, random = secureRandom, dead = []) {
    if (opponents <= 0) return 1;
    const known = hand.concat(dead);
    const remaining = createDeck().filter((c) => !known.some((k) => sameCard(k, c)));
    let total = 0;

    for (let it = 0; it < iterations; it++) {
      const deck = shuffle(remaining.slice(), random);
      const mine = eval5(replaceCards(hand, discards, deck));
      let bestOpp = -1;
      let ties = 0;
      for (let o = 0; o < opponents; o++) {
        const start = deck.splice(0, 5);
        const oppScore = eval5(replaceCards(start, chooseDiscards(start), deck));
        if (oppScore > bestOpp) {
          bestOpp = oppScore;
          ties = 0;
        }
        if (oppScore === bestOpp) ties++;
      }
      if (mine > bestOpp) total += 1;
      else if (mine === bestOpp) total += 1 / (ties + 1);
    }
    return total / iterations;
  }

  function sortHand(hand) {
    return hand.sort((a, b) => b.rank - a.rank || a.suit - b.suit);
  }

  const api = {
    SUITS,
    HAND_NAMES,
    rankLabel,
    cardToString,
    createDeck,
    secureRandom,
    shuffle,
    eval5,
    evaluate,
    estimateEquity,
    chooseDiscards,
    sortHand,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerEval = api;
})(typeof window !== 'undefined' ? window : globalThis);
