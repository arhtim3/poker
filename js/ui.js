// Browser UI: renders the table and feeds human actions into the engine.
// Seats, cards and chips are persistent DOM elements that are reconciled
// against the game state on every update, so changes can be animated.
(function () {
  'use strict';

  const { PokerGame, PHASE_NAMES } = window.PokerEngine;
  const Eval = window.PokerEval;
  const $ = (id) => document.getElementById(id);

  const els = {
    table: $('table'),
    deck: $('deck'),
    phase: $('phase'),
    pot: $('pot'),
    potBox: $('pot-box'),
    message: $('message'),
    handNo: $('hand-no'),
    ante: $('ante'),
    log: $('log'),
    logPanel: $('log-panel'),
    logToggle: $('btn-log'),
    logClose: $('btn-log-close'),
    betPanel: $('bet-panel'),
    drawPanel: $('draw-panel'),
    nextPanel: $('next-panel'),
    fold: $('btn-fold'),
    call: $('btn-call'),
    raise: $('btn-raise'),
    range: $('raise-range'),
    input: $('raise-input'),
    drawBtn: $('btn-draw'),
    next: $('btn-next'),
    quick: document.querySelectorAll('.chip-btn'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayText: $('overlay-text'),
    start: $('btn-start'),
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

  let game = null;
  let pendingAction = null; // { resolve, opts }
  let pendingDraw = null; // { resolve, selected: Set<index> }
  let seats = []; // per-player DOM refs
  let renderedHand = 0;
  let wasHandOver = true;

  // ---- small animation helpers ------------------------------------------

  const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

  function animate(el, keyframes, options) {
    if (reducedMotion || !el.animate) return null;
    return el.animate(keyframes, options);
  }

  // Counts a number up/down instead of jumping.
  function tweenNumber(el, to, { delay = 0, duration = 450, format = String } = {}) {
    const from = el._value === undefined ? to : el._value;
    el._value = to;
    cancelAnimationFrame(el._raf);
    clearTimeout(el._timer);
    if (from === to || reducedMotion) {
      el.textContent = format(to);
      return;
    }
    const run = () => {
      const start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - k, 3);
        el.textContent = format(Math.round(from + (to - from) * eased));
        if (k < 1) el._raf = requestAnimationFrame(step);
      };
      el._raf = requestAnimationFrame(step);
    };
    if (delay) el._timer = setTimeout(run, delay);
    else run();
  }

  // Fades text in whenever it changes.
  function setText(el, text) {
    if (el.textContent === text) return;
    el.textContent = text;
    if (text) animate(el, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: EASE });
  }

  // A chip that flies between two elements.
  function flyChip(fromEl, toEl, label, delay = 0) {
    if (reducedMotion) return;
    const a = center(fromEl.getBoundingClientRect());
    const b = center(toEl.getBoundingClientRect());
    const chip = document.createElement('div');
    chip.className = 'chip-fly';
    chip.textContent = label;
    document.body.appendChild(chip);
    const w = chip.offsetWidth;
    const h = chip.offsetHeight;
    chip.style.left = `${a.x - w / 2}px`;
    chip.style.top = `${a.y - h / 2}px`;
    const anim = chip.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(0.8)`, opacity: 0.2 },
      ],
      { duration: 520, delay, easing: EASE, fill: 'both' }
    );
    anim.onfinish = () => chip.remove();
  }

  // ---- cards ------------------------------------------------------------

  function makeCard(small) {
    const el = document.createElement('div');
    el.className = 'card down' + (small ? ' small' : '');
    el.innerHTML = '<div class="card-inner"><div class="face front"></div><div class="face back"></div></div>';
    return el;
  }

  // The face is filled in only when the card is shown, so hidden
  // cards never carry their value in the DOM.
  function paintFace(el, card) {
    if (el._painted) return;
    el._painted = true;
    const front = el.querySelector('.front');
    if (card.suit === 1 || card.suit === 2) front.classList.add('red');
    front.innerHTML = `<span class="rank">${Eval.rankLabel(card.rank)}</span><span class="suit">${Eval.SUITS[card.suit]}</span>`;
  }

  // Where cards come from and go back to (the pot when the deck is hidden
  // on short screens).
  function deckRect() {
    const r = els.deck.getBoundingClientRect();
    return r.width ? r : els.potBox.getBoundingClientRect();
  }

  // Flies a card element from where it is back toward the deck and removes it.
  function discardCard(el, rect, delay = 0) {
    el.remove();
    if (reducedMotion || !rect || rect.width === 0) return;
    el.classList.remove('selected');
    Object.assign(el.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      margin: '0',
      zIndex: '25',
    });
    document.body.appendChild(el);
    const a = center(rect);
    const b = center(deckRect());
    const anim = el.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(0.6) rotate(14deg)`, opacity: 0 },
      ],
      { duration: 420, delay, easing: 'ease-in', fill: 'both' }
    );
    anim.onfinish = () => el.remove();
  }

  function dealIn(el, delay, then) {
    const a = center(el.getBoundingClientRect());
    const b = center(deckRect());
    const anim = animate(
      el,
      [
        { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) rotate(-12deg) scale(0.7)`, opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 460, delay, easing: EASE, fill: 'backwards' }
    );
    if (then) {
      if (anim) anim.onfinish = then;
      else then();
    }
  }

  function syncCards(seat, p, i, dealOrder, newHand) {
    const container = seat.cards;
    const desired = p.out ? [] : p.hand;
    const first = new Map();
    for (const [card, el] of seat.cardEls) first.set(card, el.getBoundingClientRect());

    // Cards that left the hand.
    let removed = 0;
    for (const [card, el] of seat.cardEls) {
      if (!desired.includes(card)) {
        seat.cardEls.delete(card);
        discardCard(el, first.get(card), newHand ? dealOrder * 40 : removed++ * 60);
      }
    }

    // Create / reorder.
    const fresh = [];
    desired.forEach((card, idx) => {
      let el = seat.cardEls.get(card);
      if (!el) {
        el = makeCard(!p.isHuman);
        if (p.isHuman) el.insertAdjacentHTML('beforeend', '<span class="swap-tag">交換</span>');
        seat.cardEls.set(card, el);
        fresh.push({ el, card, idx });
      }
      container.appendChild(el);
      el.dataset.index = idx;
      el.classList.toggle('selected', !!(p.isHuman && pendingDraw && pendingDraw.selected.has(idx)));
    });

    // Reveal (flip) cards that are now shown.
    const freshEls = new Set(fresh.map((f) => f.el));
    desired.forEach((card, idx) => {
      const el = seat.cardEls.get(card);
      if (p.showCards && el.classList.contains('down') && !freshEls.has(el)) {
        paintFace(el, card);
        el.querySelector('.card-inner').style.transitionDelay = `${dealOrder * 140 + idx * 50}ms`;
        el.classList.remove('down');
      }
    });

    // FLIP: slide cards that moved because of sorting or insertions.
    for (const [card, el] of seat.cardEls) {
      if (freshEls.has(el) || !first.has(card) || (el.getAnimations && el.getAnimations().length)) continue;
      const before = first.get(card);
      const after = el.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        animate(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 320, easing: EASE });
      }
    }

    // Deal the new cards in from the deck.
    const players = game.players.filter((q) => !q.out).length || 1;
    fresh.forEach(({ el, card, idx }, n) => {
      const delay = newHand ? (idx * players + dealOrder) * 55 : 200 + n * 90;
      const reveal = p.showCards
        ? () => {
            paintFace(el, card);
            el.classList.remove('down');
          }
        : null;
      if (reveal && p.isHuman) paintFace(el, card);
      dealIn(el, delay, reveal);
    });
  }

  // ---- seats ------------------------------------------------------------

  function buildSeats() {
    els.table.querySelectorAll('.seat, .bet').forEach((el) => el.remove());
    seats = game.players.map((p, i) => {
      const root = document.createElement('div');
      root.className = `seat pos-${i} ${p.isHuman ? 'human' : 'cpu'}`;
      const cards = document.createElement('div');
      cards.className = 'cards';
      const plate = document.createElement('div');
      plate.className = 'plate';
      plate.innerHTML =
        '<div class="name"></div><div class="chips"></div><div class="action"></div><div class="dealer-btn is-off">D</div>';
      if (p.isHuman) root.append(cards, plate);
      else root.append(plate, cards);
      els.table.appendChild(root);

      const bet = document.createElement('div');
      bet.className = `bet pos-${i} is-off`;
      els.table.appendChild(bet);

      plate.querySelector('.name').textContent = p.name;
      return {
        root,
        cards,
        plate,
        chips: plate.querySelector('.chips'),
        action: plate.querySelector('.action'),
        dealer: plate.querySelector('.dealer-btn'),
        bet,
        betValue: 0,
        cardEls: new Map(),
      };
    });
  }

  function buildDeck() {
    els.deck.innerHTML = '';
    for (let i = 0; i < 3; i++) els.deck.appendChild(makeCard(true));
  }

  // ---- render -------------------------------------------------------------

  function render() {
    if (!game) return;
    const newHand = renderedHand !== game.handNumber;
    renderedHand = game.handNumber;

    els.handNo.textContent = `ハンド #${game.handNumber}`;
    els.ante.textContent = `参加料 ${game.ante}`;
    setText(els.phase, game.handOver ? '' : PHASE_NAMES[game.phase] || '');

    const winnerIds = new Set(game.winners.map((w) => w.player.id));
    const payout = game.handOver && !wasHandOver;
    wasHandOver = game.handOver;

    // Seat order for dealing: starting left of the dealer.
    const n = game.players.length;
    const order = new Map();
    let k = 0;
    for (let step = 1; step <= n; step++) {
      const p = game.players[(game.dealer + step) % n];
      if (!p.out) order.set(p, k++);
    }

    game.players.forEach((p, i) => {
      const seat = seats[i];
      const root = seat.root;
      root.classList.toggle('folded', p.folded && !p.out);
      root.classList.toggle('turn', game.toAct === i);
      root.classList.toggle('winner', game.handOver && winnerIds.has(p.id));
      root.classList.toggle('showdown', !!(p.result && p.showCards && !p.folded));
      root.classList.toggle('choosing', !!(p.isHuman && pendingDraw));
      root.style.opacity = p.out ? '0.25' : '';

      tweenNumber(seat.chips, p.chips, {
        delay: payout && winnerIds.has(p.id) ? 380 : 0,
        format: (v) => `${v} チップ`,
      });
      setText(seat.action, p.out ? '脱落' : p.lastAction);
      seat.dealer.classList.toggle('is-off', game.dealer !== i);

      // Bet chips in front of the seat.
      if (p.bet > 0) {
        if (p.bet !== seat.betValue) {
          seat.bet.textContent = p.bet;
          seat.bet.classList.remove('is-off');
          animate(seat.bet, [{ transform: getComputedStyle(seat.bet).transform + ' scale(1.35)' }, { transform: getComputedStyle(seat.bet).transform }], {
            duration: 260,
            easing: EASE,
          });
        }
      } else if (seat.betValue > 0) {
        flyChip(seat.bet, els.potBox, seat.betValue, order.get(p) * 60 || 0);
        seat.bet.classList.add('is-off');
      }
      seat.betValue = p.bet;

      syncCards(seat, p, i, order.get(p) || 0, newHand);
    });

    // Pot: counts up as chips arrive, then pays out to the winners.
    if (payout) {
      for (const w of game.winners) flyChip(els.potBox, seats[w.player.id].plate, `+${w.amount}`);
    }
    tweenNumber(els.pot, game.handOver ? 0 : game.pot, { delay: payout ? 0 : 250 });

    // Live hand name for the human.
    const human = game.human;
    if (game.phase === 'deal') {
      setText(els.message, '');
    } else if (!game.handOver && human && !human.out && human.hand.length === 5) {
      setText(els.message, human.folded ? 'フォールドしました' : `あなたの役: ${Eval.evaluate(human.hand).name}`);
    }
  }

  function log(message) {
    const li = document.createElement('li');
    li.textContent = message;
    if (message.startsWith('――')) li.classList.add('head');
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
  }

  // ---- controls -----------------------------------------------------------

  function showPanel(name) {
    els.betPanel.classList.toggle('is-off', name !== 'bet');
    els.drawPanel.classList.toggle('is-off', name !== 'draw');
    els.nextPanel.classList.toggle('is-off', name !== 'next');
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
      showPanel('bet');
      setControlsEnabled(true);
      els.call.textContent = opts.canCheck
        ? 'チェック'
        : opts.toCall >= player.chips
          ? `オールイン ${opts.toCall}`
          : `コール ${opts.toCall}`;

      if (opts.canRaise) {
        els.range.min = opts.minRaiseTo;
        els.range.max = opts.maxRaiseTo;
        els.range.step = g.ante;
        els.input.min = opts.minRaiseTo;
        els.input.max = opts.maxRaiseTo;
        els.input.step = g.ante;
        setRaiseValue(opts.minRaiseTo);
      } else {
        [els.raise, els.range, els.input, ...els.quick].forEach((el) => (el.disabled = true));
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

  // ---- draw -------------------------------------------------------------

  function updateDrawButton() {
    const n = pendingDraw.selected.size;
    els.drawBtn.textContent = n === 0 ? '交換しない' : `${n}枚交換する`;
  }

  function humanDraw() {
    return new Promise((resolve) => {
      pendingDraw = { resolve, selected: new Set() };
      showPanel('draw');
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
    showPanel('bet');
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
    if (e.key === 'f') els.fold.click();
    else if (e.key === 'c') els.call.click();
    else if (e.key === 'r' && !els.raise.disabled) els.raise.click();
  });

  // ---- log sheet (phones) -------------------------------------------------

  function setLogOpen(open) {
    els.logPanel.classList.toggle('open', open);
    els.logToggle.setAttribute('aria-expanded', String(open));
  }
  els.logToggle.addEventListener('click', () => setLogOpen(!els.logPanel.classList.contains('open')));
  els.logClose.addEventListener('click', () => setLogOpen(false));

  // ---- game loop ----------------------------------------------------------

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function showResult() {
    const parts = game.winners.map((w) => {
      const hand = w.player.result ? `(${w.player.result.name})` : '';
      return `${w.player.name} +${w.amount} ${hand}`;
    });
    setText(els.message, parts.join(' / '));
  }

  async function playNext() {
    showPanel('bet');
    setControlsEnabled(false);
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
        els.overlay.classList.remove('is-off');
      }, 1500);
    } else {
      showPanel('next');
      els.next.focus({ preventScroll: true });
    }
  }

  function startGame() {
    els.overlay.classList.add('is-off');
    els.log.innerHTML = '';
    els.message.textContent = '';
    game = new PokerGame({}, { update: render, log, wait, humanAction, humanDraw });
    renderedHand = 0;
    wasHandOver = true;
    buildSeats();
    render();
    playNext();
  }

  els.start.addEventListener('click', startGame);
  els.next.addEventListener('click', playNext);
  buildDeck();
  setControlsEnabled(false);
})();
