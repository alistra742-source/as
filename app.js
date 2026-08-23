'use strict';

/* =====================================================================
   Captcha Trainer
   - "Trainer" tab: human-verification checkbox + interactive challenges
   - "Data" tab:    every image challenge in the dataset, with answers
   ===================================================================== */

/* ---------- Dataset ----------
   Tiles are numbered 1–9 left-to-right, top-to-bottom.
   `solution`    = 0-based indices that clearly contain the target.
   `borderline`  = 0-based indices with only a tiny partial glimpse;
                   selecting them (or not) never counts against you. */
const CHALLENGES = [
  {
    id: 'traffic-lights',
    target: 'traffic lights',
    image: 'images/challenge-traffic-lights.jpg',
    solution: [0, 2, 4, 6, 8],
    borderline: [1, 3],
    difficulty: 'Medium',
    note: 'Squares 2 and 4 only show tiny distant signals — picking them is optional and never counts against you.',
  },
  {
    id: 'bicycles',
    target: 'bicycles',
    image: 'images/challenge-bicycles.jpg',
    solution: [0, 2, 3, 7],
    borderline: [],
    difficulty: 'Easy',
  },
  {
    id: 'crosswalks',
    target: 'crosswalks',
    image: 'images/challenge-crosswalks.jpg',
    solution: [0, 4, 5, 6, 8],
    borderline: [],
    difficulty: 'Easy',
  },
  {
    id: 'fire-hydrants',
    target: 'fire hydrants',
    image: 'images/challenge-fire-hydrants.jpg',
    solution: [0, 2, 4, 6],
    borderline: [],
    difficulty: 'Easy',
  },
  {
    id: 'buses',
    target: 'buses',
    image: 'images/challenge-buses.jpg',
    solution: [1, 3, 5, 7],
    borderline: [],
    difficulty: 'Medium',
  },
  {
    id: 'boats',
    target: 'boats',
    image: 'images/challenge-boats.jpg',
    solution: [0, 3, 6, 7],
    borderline: [4],
    difficulty: 'Medium',
    note: 'Square 5 has a tiny speck by the far pier — it is optional and never counts against you.',
  },
];

/* ---------- Persistent state ---------- */
const STORAGE_KEY = 'captcha-trainer-v1';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

const state = Object.assign(
  { verified: false, solved: [], current: 0, activeTab: 'trainer' },
  loadState() || {}
);
if (state.current < 0 || state.current >= CHALLENGES.length) state.current = 0;

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) { /* storage unavailable — session-only progress */ }
}

/* ---------- Element handles ---------- */
const $ = (sel) => document.querySelector(sel);

const tabButtons = Array.from(document.querySelectorAll('.tab'));
const panelTrainer = $('#panel-trainer');
const panelData = $('#panel-data');

const widget = $('#captcha-widget');
const checkbox = $('#human-checkbox');
const widgetLabel = $('#widget-label');
const hint = $('#verify-hint');

const card = $('#challenge-card');
const targetEl = $('#challenge-target');
const grid = $('#challenge-grid');
const statusEl = $('#challenge-status');
const verifyBtn = $('#btn-verify');
const nextBtn = $('#btn-next');
const shuffleBtn = $('#btn-shuffle');
const dotsEl = $('#progress-dots');
const progressEl = $('#trainer-progress');
const resetBtn = $('#btn-reset');

const statsEl = $('#data-stats');
const dataGrid = $('#data-grid');
const answersToggle = $('#toggle-answers');

/* ---------- Helpers ---------- */
function positionStyle(i) {
  const col = i % 3;
  const row = Math.floor(i / 3);
  return `background-position:${col * 50}% ${row * 50}%;`;
}

function promptFor(c) {
  return `Select all squares with ${c.target}`;
}

/* =====================================================================
   Tabs
   ===================================================================== */
function switchTab(name, moveFocus) {
  state.activeTab = name;
  saveState();

  tabButtons.forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    if (active && moveFocus) btn.focus();
  });

  panelTrainer.hidden = name !== 'trainer';
  panelData.hidden = name !== 'data';
  panelTrainer.classList.toggle('is-active', name === 'trainer');
  panelData.classList.toggle('is-active', name === 'data');

  if (name === 'data') renderData();
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const dir = e.key === 'ArrowRight' ? 1 : -1;
  const i = tabButtons.indexOf(document.activeElement);
  if (i === -1) return;
  const next = tabButtons[(i + dir + tabButtons.length) % tabButtons.length];
  switchTab(next.dataset.tab, true);
});

/* =====================================================================
   Human-verification checkbox
   ===================================================================== */
let checking = false;

function setCheckboxState(s) {           /* 'idle' | 'checking' | 'checked' */
  widget.dataset.state = s;
  checkbox.setAttribute('aria-checked', String(s === 'checked'));
}

function clickCheckbox() {
  if (widget.dataset.state === 'checked' || checking) return;
  checking = true;
  setCheckboxState('checking');
  hint.classList.remove('ok');
  hint.textContent = 'Verifying you are human…';

  window.setTimeout(() => {
    checking = false;
    state.verified = true;
    saveState();
    setCheckboxState('checked');
    hint.classList.add('ok');
    hint.textContent = '✓ Verification successful — the challenges are unlocked.';
    openChallengeCard(true);
  }, 850 + Math.random() * 550);
}

checkbox.addEventListener('click', clickCheckbox);
widgetLabel.addEventListener('click', clickCheckbox);

function openChallengeCard(scroll) {
  card.classList.remove('hidden');
  renderChallenge();
  if (scroll) {
    window.setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
  }
}

/* =====================================================================
   Trainer challenge flow
   ===================================================================== */
let selection = new Set();
let locked = false;

function renderChallenge() {
  const c = CHALLENGES[state.current];
  selection = new Set();
  locked = false;

  targetEl.textContent = c.target;
  grid.classList.remove('solved');
  grid.innerHTML = '';

  for (let i = 0; i < 9; i += 1) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.setAttribute('aria-pressed', 'false');
    tile.setAttribute('aria-label', `Square ${i + 1} of 9`);
    tile.innerHTML =
      `<span class="tile-bg" style="background-image:url('${c.image}');${positionStyle(i)}"></span>` +
      '<span class="tile-check" aria-hidden="true">✓</span>';
    tile.addEventListener('click', () => toggleTile(i));
    grid.appendChild(tile);
  }

  statusEl.className = 'challenge-status';
  statusEl.textContent = '';
  verifyBtn.classList.remove('hidden');
  nextBtn.classList.add('hidden');

  renderDots();
  renderProgress();
}

function toggleTile(i, force) {
  if (locked) return;
  const tile = grid.children[i];
  const wantSelected = typeof force === 'boolean' ? force : !selection.has(i);

  if (wantSelected) selection.add(i);
  else selection.delete(i);

  tile.classList.toggle('selected', wantSelected);
  tile.setAttribute('aria-pressed', String(wantSelected));
}

function verify() {
  if (locked) return;
  const c = CHALLENGES[state.current];
  const accepted = new Set([...c.solution, ...(c.borderline || [])]);

  const missed = c.solution.filter((i) => !selection.has(i));
  const wrong = [...selection].filter((i) => !accepted.has(i));

  if (missed.length === 0 && wrong.length === 0) {
    locked = true;
    if (!state.solved.includes(c.id)) state.solved.push(c.id);
    saveState();

    grid.classList.add('solved');
    statusEl.className = 'challenge-status ok';
    statusEl.textContent = state.solved.length === CHALLENGES.length
      ? '✓ Verified — and that was the last one. You solved every challenge. Certified human!'
      : '✓ Verified — perfect match. Nice work!';
    verifyBtn.classList.add('hidden');
    nextBtn.classList.remove('hidden');
    renderDots();
    renderProgress();
  } else {
    grid.classList.add('shake');
    window.setTimeout(() => grid.classList.remove('shake'), 480);

    const parts = [];
    if (missed.length) parts.push(`you missed ${missed.length} square${missed.length > 1 ? 's' : ''}`);
    if (wrong.length) parts.push(`${wrong.length} of your picks had no ${c.target}`);
    statusEl.className = 'challenge-status err';
    statusEl.textContent = `✗ Not quite — ${parts.join(' and ')}. Try again.`;

    wrong.forEach((i) => toggleTile(i, false));   /* clear wrong picks, keep the good ones */
  }
}

function nextChallenge() {
  state.current = (state.current + 1) % CHALLENGES.length;
  saveState();
  renderChallenge();
}

verifyBtn.addEventListener('click', verify);
nextBtn.addEventListener('click', nextChallenge);
shuffleBtn.addEventListener('click', nextChallenge);

function renderDots() {
  dotsEl.innerHTML = '';
  CHALLENGES.forEach((c, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'dot';
    dot.title = c.target;
    const solved = state.solved.includes(c.id);
    dot.setAttribute('aria-label', `Challenge ${i + 1}: ${c.target}${solved ? ' (solved)' : ''}`);
    if (i === state.current) dot.classList.add('current');
    if (solved) dot.classList.add('solved');
    dot.addEventListener('click', () => {
      state.current = i;
      saveState();
      renderChallenge();
    });
    dotsEl.appendChild(dot);
  });
}

function renderProgress() {
  const n = state.solved.length;
  progressEl.textContent = n === CHALLENGES.length
    ? `Solved ${n} of ${CHALLENGES.length} — all done!`
    : `Solved ${n} of ${CHALLENGES.length}`;
  progressEl.classList.toggle('done', n === CHALLENGES.length);
}

resetBtn.addEventListener('click', () => {
  state.verified = false;
  state.solved = [];
  state.current = 0;
  saveState();

  setCheckboxState('idle');
  hint.classList.remove('ok');
  hint.textContent = 'Click the checkbox to unlock the image challenges.';
  card.classList.add('hidden');
  renderProgress();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* =====================================================================
   Data tab — every image challenge with its answer key
   ===================================================================== */
function renderData() {
  const totalTargets = CHALLENGES.reduce((n, c) => n + c.solution.length, 0);
  statsEl.innerHTML =
    `<span class="stat"><b>${CHALLENGES.length}</b> challenges</span>` +
    `<span class="stat"><b>${CHALLENGES.length * 9}</b> squares</span>` +
    `<span class="stat"><b>${totalTargets}</b> target squares</span>` +
    `<span class="stat"><b>${state.solved.length}</b> solved by you</span>`;

  dataGrid.innerHTML = '';
  CHALLENGES.forEach((c, idx) => {
    const tiles = Array.from({ length: 9 }, (_, i) => {
      const isTarget = c.solution.includes(i);
      const isBorderline = (c.borderline || []).includes(i);
      const cls = isTarget ? 'is-target' : isBorderline ? 'is-borderline' : '';
      const label = isTarget ? 'Target square' : isBorderline ? 'Optional — only a tiny glimpse' : `Square ${i + 1}`;
      return `<div class="d-tile ${cls}" title="${label}" style="background-image:url('${c.image}');${positionStyle(i)}">` +
             `<span class="d-idx">${i + 1}</span><span class="d-badge" aria-hidden="true"></span></div>`;
    }).join('');

    const optionalLine = (c.borderline && c.borderline.length)
      ? `<br>${c.borderline.length} optional square${c.borderline.length > 1 ? 's' : ''}: ${c.borderline.map((i) => i + 1).join(', ')}`
      : '';

    const cardEl = document.createElement('article');
    cardEl.className = 'd-card';
    cardEl.innerHTML =
      `<div class="d-grid" role="img" aria-label="Answer key for the ${c.target} challenge">${tiles}</div>` +
      '<div class="d-body">' +
        '<div class="d-title-row">' +
          `<h3>${c.target}</h3>` +
          `<span class="chip diff-${c.difficulty.toLowerCase()}">${c.difficulty}</span>` +
          (state.solved.includes(c.id) ? '<span class="chip solved-chip">✓ Solved</span>' : '') +
        '</div>' +
        `<p class="d-prompt">“${promptFor(c)}”</p>` +
        `<p class="d-meta">${c.solution.length} target squares: ${c.solution.map((i) => i + 1).join(', ')}${optionalLine}</p>` +
        (c.note ? `<p class="d-note">${c.note}</p>` : '') +
        `<button class="practice-btn" type="button" data-idx="${idx}">Practice this challenge →</button>` +
      '</div>';
    dataGrid.appendChild(cardEl);
  });
}

answersToggle.addEventListener('change', () => {
  panelData.classList.toggle('show-answers', answersToggle.checked);
});

dataGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.practice-btn');
  if (!btn) return;

  state.current = Number(btn.dataset.idx);
  saveState();
  switchTab('trainer');

  if (state.verified) {
    openChallengeCard(false);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    widget.classList.add('pulse');
    window.setTimeout(() => widget.classList.remove('pulse'), 2500);
    widget.scrollIntoView({ behavior: 'smooth', block: 'center' });
    hint.classList.remove('ok');
    hint.textContent = 'Click the checkbox to unlock this challenge.';
  }
});

/* =====================================================================
   Init (restore previous session)
   ===================================================================== */
(function init() {
  if (state.verified) {
    setCheckboxState('checked');
    hint.classList.add('ok');
    hint.textContent = '✓ Verification successful — the challenges are unlocked.';
    openChallengeCard(false);
  } else {
    renderProgress();
  }
  panelData.classList.toggle('show-answers', answersToggle.checked);
  switchTab(state.activeTab === 'data' ? 'data' : 'trainer');
})();
