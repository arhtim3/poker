// Browser UI: renders the table and feeds human actions into the engine.
(function () {
  'use strict';

  const { PokerGame, PHASE_NAMES } = window.PokerEngine;
  const Eval = window.PokerEval;
  const $ = (id) => document.getElementById(id);

  const els = {
    table: $('table'),
    phase: $('phase'),
    pot: $('pot'),
    message: $('message'),
    handNo: $('hand-no'),
    ante: $('ante'),
    log: $('log'),
    fold: $('btn-fold'),
    call: $('btn-call'),
    raise: $('btn-raise'),
    raiseBox: $('raise-box'),
    range: $('raise-range'),
    input: $('raise-input'),
    drawBox: $('draw-box'),
    drawBtn: $('btn-draw'),
    next: $('btn-next'),
    quick: document.querySelectorAll('.chip-btn'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayText: $('overlay-text'),
    start: $('btn-start'),
  };

  let game = null;
  let pendingAction = null; // { resolve, opts }
  let pendingDraw = null; // { resolve, selected: Set<index> }
  let dealtKeys = new Set(); // cards already on screen (animate only new ones)
  let renderedHand = 0;

  // ---- rendering ---------------------------------------------------------

  function cardEl(card, { hidden = false, small = false, key = null } = {}) {
    const el = document.createElement('div');
    el.className = 'card' + (small ? ' small' : '');
    if (key && !dealtKeys.has(key)) {
      dealtKeys.add(key);
      el.classList.add('deal');
    }
    if (hidden) {
      el.classList.add('back');
      return el;
    }
    if (card.suit === 1 || card.suit === 2) el.classList.add('red');
    el.innerHTML = `<span class="rank">${Eval.rankLabel(card.rank)}</span><span class="suit">${Eval.SUITS[card.suit]}</span>`;
    return el;
  }

  const cardKey = (c) => `${c.rank}${c.suit}`;

  function render() {
    if (!game) return;
    if (renderedHand !== game.handNumber) {
      renderedHand = game.handNumber;
      dealtKeys = new Set();
    }
    els.handNo.textContent = `ハンド #${game.handNumber}`;
    els.ante.textContent = `参加料 ${game.ante}`;
    els.phase.textContent = game.handOver ? '' : PHASE_NAMES[game.phase] || '';
    const potTotal = game.handOver ? game.winners.reduce((t, w) => t + w.amount, 0) : game.pot;
    els.pot.textContent = `ポット: ${potTotal}`;

    els.table.querySelectorAll('.seat, .bet').forEach((el) => el.remove());
    const winnerIds = new Set(game.winners.map((w) => w.player.id));
    game.players.forEach((p, i) => {
      const seat = document.createElement('div');
      seat.className = `seat pos-${i} ${p.isHuman ? 'human' : 'cpu'}`;
      if (p.folded) seat.classList.add('folded');
      if (game.toAct === i) seat.classList.add('turn');
      if (game.handOver && winnerIds.has(p.id)) seat.classList.add('winner');
      if (p.isHuman && pendingDraw) seat.classList.add('choosing');

      const cards = document.createElement('div');
      cards.className = 'cards';
      if (!p.out) {
        p.hand.forEach((c, k) => {
          const el = cardEl(c, {
            hidden: !p.showCards,
            small: !p.isHuman,
            key: `p${i}-${p.showCards ? cardKey(c) : k}`,
          });
          if (p.isHuman) {
            el.dataset.index = k;
            if (pendingDraw && pendingDraw.selected.has(k)) el.classList.add('selected');
          }
          cards.appendChild(el);
        });
      }

      const plate = document.createElement('div');
      plate.className = 'plate';
      const status = p.out ? '脱落' : p.lastAction;
      plate.innerHTML = `
        <div class="name">${p.name}</div>
        <div class="chips">${p.chips} チップ</div>
        <div class="action">${status}</div>
        ${p.result && p.showCards ? `<div class="hand-name">${p.result.name}</div>` : ''}
        ${game.dealer === i ? '<div class="dealer-btn">D</div>' : ''}
      `;

      // Human: cards above name (toward table). CPUs: name then cards.
      if (i === 0) {
        seat.appendChild(cards);
        seat.appendChild(plate);
      } else {
        seat.appendChild(plate);
        seat.appendChild(cards);
      }
      els.table.appendChild(seat);

      if (p.bet > 0) {
        const bet = document.createElement('div');
        bet.className = `bet pos-${i}`;
        bet.textContent = p.bet;
        els.table.appendChild(bet);
      }
    });

    // Live hand name for the human.
    const human = game.human;
    if (!game.handOver && human && !human.out && human.hand.length === 5) {
      els.message.textContent = human.folded ? '' : `あなたの役: ${Eval.evaluate(human.hand).name}`;
    }
  }

  function log(message) {
    const li = document.createElement('li');
    li.textContent = message;
    if (message.startsWith('――')) li.classList.add('head');
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
  }

  // ---- human input: betting ----------------------------------------------

  function showBetControls(show) {
    [els.fold, els.call, els.raiseBox].forEach((el) => el.classList.toggle('hidden', !show));
  }

  function setControlsEnabled(enabled) {
    [els.fold, els.call, els.raise, els.range, els.input, ...els.quick].forEach((el) => (el.disabled = !enabled));
  }

  function clampRaise(value) {
    const opts = pendingAction.opts;
    const v = Math.round(Number(value) || 0);
    return Math.max(opts.minRaiseTo, Math.min(opts.maxRaiseTo, v));
  }

  function setRaiseValue(value) {
    if (!pendingAction) return;
    const v = clampRaise(value);
    els.range.value = v;
    els.input.value = v;
    const opts = pendingAction.opts;
    const verb = opts.isBet ? 'ベット' : 'レイズ';
    els.raise.textContent = v >= opts.maxRaiseTo ? `オールイン ${v}` : `${verb} ${v}`;
  }

  function humanAction(g, player, opts) {
    return new Promise((resolve) => {
      pendingAction = { resolve, opts };
      showBetControls(true);
      setControlsEnabled(true);
      els.fold.disabled = opts.canCheck; // no reason to fold when checking is free
      els.call.textContent = opts.canCheck
        ? 'チェック'
        : opts.toCall >= player.chips
          ? `オールイン ${opts.toCall}`
          : `コール ${opts.toCall}`;

      const raiseEls = [els.raise, els.range, els.input, ...els.quick];
      if (opts.canRaise) {
        els.range.min = opts.minRaiseTo;
        els.range.max = opts.maxRaiseTo;
        els.range.step = g.ante;
        els.input.min = opts.minRaiseTo;
        els.input.max = opts.maxRaiseTo;
        els.input.step = g.ante;
        setRaiseValue(opts.minRaiseTo);
      } else {
        raiseEls.forEach((el) => (el.disabled = true));
        els.raise.textContent = opts.isBet ? 'ベット' : 'レイズ';
      }
    });
  }

  function submit(action) {
    if (!pendingAction) return;
    const { resolve } = pendingAction;
    pendingAction = null;
    setControlsEnabled(false);
    resolve(action);
  }

  els.fold.addEventListener('click', () => submit({ type: 'fold' }));
  els.call.addEventListener('click', () => submit({ type: pendingAction && pendingAction.opts.canCheck ? 'check' : 'call' }));
  els.raise.addEventListener('click', () => {
    if (!pendingAction) return;
    submit({ type: 'raise', amount: clampRaise(els.input.value) });
  });
  els.range.addEventListener('input', () => setRaiseValue(els.range.value));
  els.input.addEventListener('change', () => setRaiseValue(els.input.value));
  els.quick.forEach((btn) =>
    btn.addEventListener('click', () => {
      if (!pendingAction) return;
      const frac = btn.dataset.frac;
      if (frac === 'all') return setRaiseValue(pendingAction.opts.maxRaiseTo);
      const human = game.human;
      const toCall = pendingAction.opts.toCall;
      const unit = game.ante;
      // Pot-sized raise: call first, then raise by the resulting pot times frac.
      const target = game.currentBet + Math.round(((game.pot + toCall) * Number(frac)) / unit) * unit;
      setRaiseValue(Math.max(target, human.bet + toCall));
    })
  );

  // ---- human input: draw -------------------------------------------------

  function updateDrawButton() {
    const n = pendingDraw.selected.size;
    els.drawBtn.textContent = n === 0 ? '交換しない' : `${n}枚交換する`;
  }

  function humanDraw() {
    return new Promise((resolve) => {
      pendingDraw = { resolve, selected: new Set() };
      showBetControls(false);
      els.drawBox.classList.remove('hidden');
      updateDrawButton();
      render();
    });
  }

  function toggleDrawCard(index) {
    if (!pendingDraw) return;
    const sel = pendingDraw.selected;
    if (sel.has(index)) sel.delete(index);
    else sel.add(index);
    updateDrawButton();
    render();
  }

  els.table.addEventListener('click', (e) => {
    const card = e.target.closest('.seat.human .card');
    if (card && card.dataset.index !== undefined) toggleDrawCard(Number(card.dataset.index));
  });

  els.drawBtn.addEventListener('click', () => {
    if (!pendingDraw) return;
    const { resolve, selected } = pendingDraw;
    pendingDraw = null;
    els.drawBox.classList.add('hidden');
    showBetControls(true);
    resolve([...selected]);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === els.input) return;
    if (pendingDraw) {
      if (e.key >= '1' && e.key <= '5') toggleDrawCard(Number(e.key) - 1);
      else if (e.key === 'Enter' || e.key === 'd') els.drawBtn.click();
      return;
    }
    if (!pendingAction) return;
    if (e.key === 'f' && !els.fold.disabled) els.fold.click();
    else if (e.key === 'c') els.call.click();
    else if (e.key === 'r' && !els.raise.disabled) els.raise.click();
  });

  // ---- game loop ---------------------------------------------------------

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function showResult() {
    const parts = game.winners.map((w) => {
      const hand = w.player.result ? `(${w.player.result.name})` : '';
      return `${w.player.name} +${w.amount} ${hand}`;
    });
    els.message.textContent = parts.join(' / ');
  }

  async function playNext() {
    els.next.classList.add('hidden');
    showBetControls(true);
    await game.playHand();
    showResult();

    if (game.isGameOver()) {
      const won = game.human.chips > 0;
      setTimeout(() => {
        els.overlayTitle.textContent = won ? '🏆 優勝！' : 'ゲームオーバー';
        els.overlayText.textContent = won
          ? `${game.handNumber} ハンドで全員のチップを獲得しました！`
          : `${game.handNumber} ハンド目でチップがなくなりました。`;
        els.start.textContent = 'もう一度遊ぶ';
        els.overlay.classList.remove('hidden');
      }, 1500);
    } else {
      els.next.classList.remove('hidden');
      els.next.focus();
    }
  }

  function startGame() {
    els.overlay.classList.add('hidden');
    els.log.innerHTML = '';
    els.message.textContent = '';
    game = new PokerGame({}, { update: render, log, wait, humanAction, humanDraw });
    setControlsEnabled(false);
    playNext();
  }

  els.start.addEventListener('click', startGame);
  els.next.addEventListener('click', playNext);
  setControlsEnabled(false);
})();
