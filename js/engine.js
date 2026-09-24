// Five-card draw poker engine (no DOM). The UI plugs in through `hooks`:
//   hooks.update(game)                     -> re-render
//   hooks.log(message)                     -> append to the log
//   hooks.wait(ms)                         -> Promise for pacing
//   hooks.humanAction(game, player, opts)  -> Promise<{type, amount?}>
//   hooks.humanDraw(game, player)          -> Promise<number[]> (indices to discard)
//
// Hand flow: deal 5 cards -> ante -> betting -> draw -> betting -> showdown.
(function (root) {
  'use strict';

  const Eval =
    typeof module !== 'undefined' && module.exports ? require('./evaluator.js') : root.PokerEval;

  const PHASE_NAMES = {
    ante: '参加料',
    bet1: '1回目のベット',
    draw: 'カード交換',
    bet2: '2回目のベット',
    showdown: 'ショーダウン',
    reveal: '手札公開',
  };

  const CPU_STYLES = [
    { aggression: 0.6, looseness: 0.5 },
    { aggression: 0.3, looseness: 0.2 },
    { aggression: 0.9, looseness: 0.7 },
    { aggression: 0.5, looseness: 0.4 },
    { aggression: 0.7, looseness: 0.3 },
  ];

  class PokerGame {
    constructor(options = {}, hooks = {}) {
      this.hooks = Object.assign(
        {
          update() {},
          log() {},
          wait: () => Promise.resolve(),
          humanAction: null,
          humanDraw: null,
        },
        hooks
      );
      this.random = options.random || Eval.secureRandom;
      this.startingChips = options.startingChips || 1000;
      this.ante = options.ante || 10;
      this.anteUpEvery = options.anteUpEvery || 10;
      this.equityIterations = options.equityIterations || 300;
      const names = options.names || ['あなた', 'CPU 1', 'CPU 2', 'CPU 3'];
      const humanIndex = options.humanIndex === undefined ? 0 : options.humanIndex;
      this.players = names.map((name, i) => ({
        id: i,
        name,
        isHuman: i === humanIndex,
        style: CPU_STYLES[i % CPU_STYLES.length],
        chips: this.startingChips,
        hand: [],
        discarded: [],
        drew: null,
        bet: 0,
        totalBet: 0,
        folded: false,
        allIn: false,
        out: false,
        lastAction: '',
        showCards: i === humanIndex,
        result: null,
      }));
      this.dealer = -1;
      this.handNumber = 0;
      this.deck = [];
      this.phase = null;
      this.currentBet = 0;
      this.minRaise = this.betUnit;
      this.toAct = -1;
      this.winners = [];
      this.handOver = true;
    }

    // ---- helpers ---------------------------------------------------------

    // Smallest bet / raise increment.
    get betUnit() {
      return this.ante * 2;
    }

    get pot() {
      return this.players.reduce((sum, p) => sum + p.totalBet, 0);
    }

    get human() {
      return this.players.find((p) => p.isHuman);
    }

    inHand() {
      return this.players.filter((p) => !p.folded && !p.out);
    }

    canAct() {
      return this.players.filter((p) => !p.folded && !p.out && !p.allIn);
    }

    nextIndex(from, predicate) {
      const n = this.players.length;
      for (let step = 1; step <= n; step++) {
        const i = (from + step) % n;
        if (predicate(this.players[i])) return i;
      }
      return -1;
    }

    remainingPlayers() {
      return this.players.filter((p) => p.chips > 0);
    }

    isGameOver() {
      const human = this.human;
      return (human && human.chips === 0) || this.remainingPlayers().length <= 1;
    }

    draw() {
      return this.deck.pop();
    }

    putChips(player, amount) {
      const paid = Math.min(amount, player.chips);
      player.chips -= paid;
      player.bet += paid;
      player.totalBet += paid;
      if (player.chips === 0) player.allIn = true;
      return paid;
    }

    // Legal options for the player whose turn it is.
    actionOptions(player) {
      const toCall = Math.max(0, this.currentBet - player.bet);
      const maxTo = player.bet + player.chips;
      const minTo = Math.min(this.currentBet + this.minRaise, maxTo);
      return {
        toCall: Math.min(toCall, player.chips),
        canCheck: toCall === 0,
        canRaise: player.chips > toCall && this.canAct().length > 1,
        minRaiseTo: minTo,
        maxRaiseTo: maxTo,
        isBet: this.currentBet === 0,
      };
    }

    // ---- hand flow ------------------------------------------------------

    async playHand() {
      if (this.isGameOver()) return false;
      this.startHand();
      this.hooks.update(this);
      await this.hooks.wait(1300); // let the deal animation play

      this.collectAntes();
      this.hooks.update(this);
      await this.hooks.wait(700);

      for (const phase of ['bet1', 'draw', 'bet2']) {
        if (this.inHand().length === 1) break;
        this.phase = phase;
        this.resetStreet();
        this.hooks.update(this);
        await this.hooks.wait(450);
        if (phase === 'draw') await this.drawRound();
        else if (this.canAct().length >= 2) await this.bettingRound();
        this.resetStreet();
        this.hooks.update(this);
      }

      // Everyone's cards are turned face up at the end of every hand,
      // including when all but one player folded.
      this.revealHands();
      this.hooks.update(this);
      await this.hooks.wait(1200);
      this.finishHand();
      this.handOver = true;
      this.hooks.update(this);
      return true;
    }

    startHand() {
      this.handNumber++;
      if (this.anteUpEvery && this.handNumber > 1 && (this.handNumber - 1) % this.anteUpEvery === 0) {
        this.ante *= 2;
        this.hooks.log(`参加料が ${this.ante} に上がりました`);
      }
      this.handOver = false;
      this.winners = [];
      this.phase = 'deal';
      this.revealed = false;
      this.deck = Eval.shuffle(Eval.createDeck(), this.random);
      for (const p of this.players) {
        p.out = p.chips === 0;
        p.hand = [];
        p.discarded = [];
        p.drew = null;
        p.bet = 0;
        p.totalBet = 0;
        p.folded = p.out;
        p.allIn = false;
        p.lastAction = '';
        p.showCards = p.isHuman;
        p.result = null;
      }

      const active = (p) => !p.out;
      this.dealer = this.nextIndex(this.dealer, active);
      this.hooks.log(`―― ハンド #${this.handNumber} ――`);
      for (let round = 0; round < 5; round++) {
        for (let step = 1; step <= this.players.length; step++) {
          const p = this.players[(this.dealer + step) % this.players.length];
          if (active(p)) p.hand.push(this.draw());
        }
      }
      for (const p of this.players) Eval.sortHand(p.hand);
    }

    collectAntes() {
      this.phase = 'ante';
      for (const p of this.inHand()) {
        this.putChips(p, this.ante);
        p.lastAction = p.allIn ? `参加料 ${p.totalBet} (オールイン)` : `参加料 ${p.totalBet}`;
      }
      this.hooks.log(`全員が参加料 ${this.ante} を支払いました`);
    }

    resetStreet() {
      for (const p of this.players) p.bet = 0;
      this.currentBet = 0;
      this.minRaise = this.betUnit;
    }

    async bettingRound() {
      let index = this.nextIndex(this.dealer, (p) => !p.folded && !p.out && !p.allIn);
      const acted = new Set();
      const needs = (p) =>
        !p.folded && !p.out && !p.allIn && (!acted.has(p) || p.bet < this.currentBet);

      while (index !== -1) {
        if (this.inHand().length <= 1) break;
        if (!this.players.some(needs)) break;

        const player = this.players[index];
        if (needs(player)) {
          // Nobody left to bet against: just mark as done.
          if (this.canAct().length === 1 && player.bet >= this.currentBet) {
            acted.add(player);
          } else {
            this.toAct = index;
            this.hooks.update(this);
            const opts = this.actionOptions(player);
            const action = player.isHuman
              ? await this.hooks.humanAction(this, player, opts)
              : await this.cpuAction(player, opts);
            const reopened = this.applyAction(player, action, opts);
            if (reopened) acted.clear();
            acted.add(player);
            this.toAct = -1;
            this.hooks.update(this);
          }
        }
        index = (index + 1) % this.players.length;
      }
      this.toAct = -1;
    }

    async drawRound() {
      this.hooks.log('カード交換');
      for (let step = 1; step <= this.players.length; step++) {
        const index = (this.dealer + step) % this.players.length;
        const player = this.players[index];
        if (player.folded || player.out) continue;
        this.toAct = index;
        this.hooks.update(this);
        let discards;
        if (player.isHuman) {
          discards = await this.hooks.humanDraw(this, player);
        } else {
          await this.hooks.wait(500 + this.random() * 400);
          discards = Eval.chooseDiscards(player.hand);
        }
        this.exchange(player, discards);
        this.toAct = -1;
        this.hooks.update(this);
      }
    }

    exchange(player, discards) {
      const unique = [...new Set(discards)].filter((i) => Number.isInteger(i) && i >= 0 && i < player.hand.length);
      player.discarded = unique.map((i) => player.hand[i]);
      player.hand = player.hand.filter((c, i) => !unique.includes(i));
      for (let k = 0; k < unique.length; k++) player.hand.push(this.draw());
      Eval.sortHand(player.hand);
      player.drew = unique.length;
      player.lastAction = unique.length === 0 ? '交換なし' : `${unique.length}枚交換`;
      this.hooks.log(`${player.name}: ${player.lastAction}`);
    }

    // Returns true when the action raised the bet (others must act again).
    applyAction(player, action, opts) {
      const type = action.type;
      if (type === 'fold') {
        player.folded = true;
        player.lastAction = 'フォールド';
        this.hooks.log(`${player.name}: フォールド`);
        return false;
      }
      if (type === 'check' && opts.canCheck) {
        player.lastAction = 'チェック';
        this.hooks.log(`${player.name}: チェック`);
        return false;
      }
      if (type === 'raise' && opts.canRaise) {
        const target = Math.max(opts.minRaiseTo, Math.min(opts.maxRaiseTo, Math.floor(action.amount)));
        const previousBet = this.currentBet;
        this.putChips(player, target - player.bet);
        if (player.bet > previousBet) {
          const raiseSize = player.bet - previousBet;
          if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
          this.currentBet = player.bet;
          const verb = previousBet === 0 ? 'ベット' : 'レイズ';
          player.lastAction = player.allIn ? `オールイン ${player.bet}` : `${verb} ${player.bet}`;
          this.hooks.log(`${player.name}: ${player.lastAction}`);
          return true;
        }
        player.lastAction = player.allIn ? `オールイン ${player.bet}` : `コール ${player.bet}`;
        this.hooks.log(`${player.name}: ${player.lastAction}`);
        return false;
      }
      // call (also the fallback for any illegal action)
      if (opts.toCall === 0) {
        player.lastAction = 'チェック';
        this.hooks.log(`${player.name}: チェック`);
        return false;
      }
      this.putChips(player, opts.toCall);
      player.lastAction = player.allIn ? `オールイン ${player.bet}` : `コール ${player.bet}`;
      this.hooks.log(`${player.name}: ${player.lastAction}`);
      return false;
    }

    // Split contributions into main pot and side pots.
    buildPots() {
      const levels = [...new Set(this.players.filter((p) => p.totalBet > 0).map((p) => p.totalBet))].sort(
        (a, b) => a - b
      );
      const pots = [];
      let previous = 0;
      for (const level of levels) {
        let amount = 0;
        for (const p of this.players) amount += Math.max(0, Math.min(p.totalBet, level) - previous);
        const eligible = this.players.filter((p) => !p.folded && !p.out && p.totalBet >= level);
        if (amount > 0) {
          // A level nobody still in the hand reached goes back to the last pot.
          if (eligible.length === 0 && pots.length) pots[pots.length - 1].amount += amount;
          else pots.push({ amount, eligible });
        }
        previous = level;
      }
      // Merge consecutive pots with the same eligible players.
      const merged = [];
      for (const pot of pots) {
        const last = merged[merged.length - 1];
        if (last && last.eligible.length === pot.eligible.length && last.eligible.every((p) => pot.eligible.includes(p))) {
          last.amount += pot.amount;
        } else merged.push({ amount: pot.amount, eligible: pot.eligible.slice() });
      }
      return merged;
    }

    // Turns every dealt hand face up, folded ones included. Folded hands
    // are shown for information only and never win a pot.
    revealHands() {
      this.phase = this.inHand().length > 1 ? 'showdown' : 'reveal';
      this.revealed = true;
      for (const p of this.players) {
        if (p.out || p.hand.length === 0) continue;
        p.showCards = true;
        p.result = Eval.evaluate(p.hand);
        p.lastAction = p.result.name; // the dimmed seat already shows it folded
        const note = p.folded ? ' (フォールド)' : '';
        this.hooks.log(`${p.name}: ${p.hand.map(Eval.cardToString).join(' ')} → ${p.result.name}${note}`);
      }
    }

    finishHand() {
      if (!this.revealed) this.revealHands();
      const contenders = this.inHand();
      const winnings = new Map();

      if (contenders.length === 1) {
        const winner = contenders[0];
        const amount = this.pot;
        winner.chips += amount;
        winnings.set(winner, amount);
        this.hooks.log(`${winner.name} が ${amount} チップを獲得`);
      } else {
        const pots = this.buildPots();
        pots.forEach((pot, i) => {
          const best = Math.max(...pot.eligible.map((p) => p.result.score));
          const potWinners = pot.eligible.filter((p) => p.result.score === best);
          const share = Math.floor(pot.amount / potWinners.length);
          let remainder = pot.amount - share * potWinners.length;
          // Odd chips go to the first winner left of the dealer.
          const ordered = [];
          for (let step = 1; step <= this.players.length; step++) {
            const p = this.players[(this.dealer + step) % this.players.length];
            if (potWinners.includes(p)) ordered.push(p);
          }
          for (const p of ordered) {
            const amount = share + (remainder > 0 ? 1 : 0);
            if (remainder > 0) remainder--;
            p.chips += amount;
            winnings.set(p, (winnings.get(p) || 0) + amount);
          }
          const label = pots.length > 1 ? (i === 0 ? 'メインポット' : `サイドポット${i}`) : 'ポット';
          this.hooks.log(
            `${label} ${pot.amount}: ${ordered.map((p) => p.name).join('・')} (${potWinners[0].result.name})`
          );
        });
      }

      for (const p of this.players) {
        p.totalBet = 0;
        p.bet = 0;
      }
      this.winners = [...winnings.entries()].map(([player, amount]) => ({ player, amount }));
      for (const p of this.players) {
        if (!p.out && p.chips === 0) this.hooks.log(`${p.name} はチップがなくなりました`);
      }
    }

    // ---- CPU ------------------------------------------------------------

    async cpuAction(player, opts) {
      await this.hooks.wait(600 + this.random() * 600);
      const opponents = this.inHand().length - 1;
      const beforeDraw = this.phase === 'bet1';
      const equity = Eval.estimateEquity(
        player.hand,
        beforeDraw ? Eval.chooseDiscards(player.hand) : [],
        opponents,
        this.equityIterations,
        this.random,
        player.discarded
      );
      // 1.0 means "average hand at this table"; >1 is better than average.
      let strength = equity * (opponents + 1);
      // Opponents who stood pat probably hold something real.
      if (!beforeDraw) {
        for (const p of this.inHand()) if (p !== player && p.drew === 0) strength *= 0.75;
      }
      const adjustedEquity = strength / (opponents + 1);
      const pot = this.pot;
      const { aggression, looseness } = player.style;
      const r = this.random();
      const potOdds = opts.toCall / (pot + opts.toCall);
      const unit = this.betUnit;

      const sizedRaise = (fraction) => {
        const base = opts.isBet ? 0 : this.currentBet;
        const amount = base + Math.max(unit, Math.round((pot * fraction) / unit) * unit);
        return { type: 'raise', amount: Math.max(opts.minRaiseTo, Math.min(opts.maxRaiseTo, amount)) };
      };

      if (opts.canCheck) {
        if (opts.canRaise && strength > 1.9 - aggression * 0.4 && r < 0.6 + aggression * 0.3) {
          return sizedRaise(strength > 2.4 ? 0.9 : 0.6);
        }
        if (opts.canRaise && r < aggression * 0.12) return sizedRaise(0.5); // bluff
        return { type: 'check' };
      }

      if (opts.canRaise && strength > 2.1 - aggression * 0.3 && r < 0.5 + aggression * 0.4) {
        return sizedRaise(adjustedEquity > 0.8 ? 1.2 : 0.8);
      }
      const margin = 0.08 - looseness * 0.1;
      if (adjustedEquity > potOdds + margin) return { type: 'call' };
      // Cheap calls with some looseness.
      if (opts.toCall <= unit && r < looseness * 0.6) return { type: 'call' };
      if (opts.canRaise && r < aggression * 0.04) return sizedRaise(0.8); // bluff raise
      return { type: 'fold' };
    }
  }

  const api = { PokerGame, PHASE_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
