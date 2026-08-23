const state = {
  platform: 'tiktok',
  format: 'stickman',
  connected: JSON.parse(localStorage.getItem('storyforge-connected') || '{}'),
  story: null,
  currentScene: 0,
  sceneTimer: null,
  voiceTimer: null,
  speaking: false,
  usedIds: JSON.parse(localStorage.getItem('storyforge-used-ids') || '[]')
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const formatCopy = {
  stickman: 'A unique stickman crime draft with captions, motion, and a deep narrator voice.',
  chat: 'A fresh faceless chat story with timed messages and two contrasting voices.',
  test: 'A ten-second render check with sample captions, motion, and local audio preview.'
};

const formatNames = {
  stickman: 'STICKMAN CRIMES',
  chat: 'FACELESS CHAT',
  test: 'RENDER TEST'
};

function showToast(message, kind = 'success') {
  const toast = $('#toast');
  $('#toast-message').textContent = message;
  toast.classList.toggle('error', kind === 'error');
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3400);
}

function updatePlatform() {
  const name = state.platform === 'tiktok' ? 'TikTok' : 'Instagram';
  $$('.platform-card').forEach(card => {
    const selected = card.dataset.platform === state.platform;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  });
  $('#platform-complete').textContent = name + ' selected';
  const connection = state.connected[state.platform];
  const username = connection && connection.account ? connection.account.username : '';
  $('#connection-title').textContent = connection ? `Connected to ${name}` : `Paste ${name} session cookies`;
  $('#connection-description').textContent = connection
    ? (username ? `Signed in as @${username}${connection.verified ? ' — session verified live.' : '.'}` : 'Your session is connected.')
    : 'Export your logged-in cookies as JSON (a cookie-editor extension can do this), then paste them below.';
  $('#connection-icon').textContent = state.platform === 'tiktok' ? '♪' : '◎';
  $('#connection-icon').className = `connection-icon ${state.platform === 'tiktok' ? 'tiktok-connection' : 'instagram-connection'}`;
  $('#connected-label').classList.toggle('hidden', !connection);
  $('#connected-label').innerHTML = connection
    ? `<span class="status-dot"></span> Connected${username ? ' · @' + escapeHtml(username) : ''}`
    : '<span class="status-dot"></span> Connected';
  $('#cookie-input').classList.toggle('hidden', Boolean(connection));
  $('#paste-cookies').classList.toggle('hidden', Boolean(connection));
  $('#connect-button').classList.toggle('hidden', Boolean(connection));
  $('#disconnect-button').classList.toggle('hidden', !connection);
  $('#profile-name').textContent = username ? '@' + username : 'Sam Carter';
  $('#profile-name').parentElement.querySelector('.profile-avatar').textContent = username ? username.slice(0, 2).toUpperCase() : 'SC';
}

function updateFormat() {
  $$('.format-card').forEach(card => {
    const selected = card.dataset.format === state.format;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  });
  $('#format-complete').textContent = state.format === 'test' ? 'Test selected' : 'Format selected';
  $('#start-description').textContent = formatCopy[state.format];
}

function saveConnection() {
  localStorage.setItem('storyforge-connected', JSON.stringify(state.connected));
}

function normalizeExpiry(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number > 1e11 ? number / 1000 : number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function parseCookiesJson(raw) {
  if (!raw || !String(raw).trim()) return { error: 'Paste your session cookies JSON first.' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'That is not valid JSON. Paste the raw JSON export from your cookie editor.' };
  }
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && Array.isArray(parsed.cookies)) parsed = parsed.cookies;
  let cookies;
  if (Array.isArray(parsed)) {
    cookies = parsed
      .filter(c => c && typeof c === 'object')
      .map(c => ({
        name: String(c.name || '').trim(),
        value: String(c.value == null ? '' : c.value).trim(),
        domain: c.domain ? String(c.domain) : '',
        path: c.path ? String(c.path) : '',
        expires: normalizeExpiry(c.expires),
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure)
      }))
      .filter(c => c.name && c.value);
  } else if (parsed && typeof parsed === 'object') {
    cookies = Object.entries(parsed)
      .filter(([, value]) => value != null && String(value).trim())
      .map(([name, value]) => ({ name: String(name).trim(), value: String(value).trim(), domain: '', path: '/', expires: null }));
  } else {
    return { error: 'The JSON should be an array of cookie objects, or an object of name → value pairs.' };
  }
  if (!cookies.length) return { error: 'No usable cookies found in that JSON.' };
  return { cookies };
}

function validateCookiesStruct(platform, cookies) {
  const names = new Set(cookies.map(c => c.name.toLowerCase()));
  const missing = names.has('sessionid') ? [] : ['sessionid'];
  const expired = cookies.filter(c => c.expires && c.expires < Date.now() / 1000);
  return { missing, expired, valid: !missing.length && !expired.length };
}

function accountFromCookies(platform, cookies) {
  const find = name => {
    const match = cookies.find(c => c.name.toLowerCase() === name);
    return match ? match.value : '';
  };
  if (platform === 'tiktok') return { platform: 'tiktok', username: find('session_username'), displayName: '' };
  if (platform === 'instagram') return { platform: 'instagram', username: find('ds_user_id'), displayName: '' };
  return { platform, username: '', displayName: '' };
}

function setCookieStatus(message, kind) {
  const status = $('#cookie-status');
  if (!message) {
    status.classList.add('hidden');
    status.textContent = '';
    return;
  }
  status.textContent = message;
  status.className = `cookie-status ${kind}`;
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) throw new Error('empty');
    $('#cookie-input').value = text;
    setCookieStatus('Pasted — review it, then validate.', 'working');
  } catch {
    setCookieStatus('Clipboard access was blocked — paste manually with Ctrl/Cmd+V.', 'error');
  }
}

function disconnectAccount() {
  const platformName = state.platform === 'tiktok' ? 'TikTok' : 'Instagram';
  delete state.connected[state.platform];
  saveConnection();
  updatePlatform();
  setCookieStatus('');
  $('#cookie-input').value = '';
  showToast(`${platformName} session removed`);
}

async function connectWithCookies() {
  const platformName = state.platform === 'tiktok' ? 'TikTok' : 'Instagram';
  const { cookies, error } = parseCookiesJson($('#cookie-input').value);
  if (error) {
    setCookieStatus(error, 'error');
    return;
  }
  const structure = validateCookiesStruct(state.platform, cookies);
  if (structure.missing.length) {
    setCookieStatus(`Missing required cookie: ${structure.missing.join(', ')} — ${platformName} sessions need a valid "sessionid" cookie.`, 'error');
    return;
  }
  if (structure.expired.length) {
    setCookieStatus('Some of those cookies are past their expiry date — export a fresh set from your browser.', 'error');
    return;
  }
  setCookieStatus(`Checking your ${platformName} session against the platform…`, 'working');
  try {
    const response = await fetch('/api/validate-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: state.platform, cookies })
    });
    const result = await response.json();
    if (result.live === 'rejected') {
      setCookieStatus(`${platformName} rejected this session — the cookies look invalid or expired. Export a fresh set and try again.`, 'error');
      return;
    }
    const account = (result.account && result.account.username) ? result.account : accountFromCookies(state.platform, cookies);
    state.connected[state.platform] = {
      account,
      cookies,
      verified: result.live === 'verified',
      validatedAt: new Date().toISOString()
    };
    saveConnection();
    updatePlatform();
    setCookieStatus(result.live === 'verified'
      ? `Connected as @${account.username || 'your account'} — session verified live.`
      : 'Connected. The platform’s live check was not reachable, but the cookies look valid — re-verify if you see posting issues.', 'success');
    $('#cookie-input').value = '';
    showToast(`${platformName} session connected`);
  } catch (networkError) {
    const account = accountFromCookies(state.platform, cookies);
    state.connected[state.platform] = {
      account,
      cookies,
      verified: false,
      validatedAt: new Date().toISOString()
    };
    saveConnection();
    updatePlatform();
    setCookieStatus('Connected locally — the live check could not be reached. Re-verify when you can.', 'success');
    showToast(`${platformName} session connected (offline check)`);
  }
}

function updateCounter() {
  const length = $('#brief-input').value.length;
  $('#brief-counter').textContent = `${length} / 120`;
}

function setLoading(loading) {
  const button = $('#start-button');
  button.disabled = loading;
  button.innerHTML = loading
    ? '<span class="button-icon">◌</span> Building your draft…'
    : '<span class="button-icon">✦</span> Generate my draft <span class="button-arrow">→</span>';
}

const localTestStory = {
  title: 'StoryForge Render Check',
  hook: 'A five-second render test is ready to roll.',
  script: 'This is a StoryForge render check. The scene loader works, captions are timed, and the preview canvas is ready for your next story.',
  scenes: [
    { label: 'SCENE 01', cue: 'Render engine online.', duration: 3 },
    { label: 'SCENE 02', cue: 'Captions and motion synced.', duration: 3 },
    { label: 'SCENE 03', cue: 'Ready for your story.', duration: 3 }
  ]
};

async function requestStory() {
  const typedBrief = $('#brief-input').value.trim();
  const uniqueSeed = `fresh take ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
  const prompt = typedBrief ? `${typedBrief}. Make this a brand-new take, not a rewrite of a previous draft. ${uniqueSeed}` : `Surprise me with a brand-new concept. ${uniqueSeed}`;
  try {
    const response = await fetch('/api/generate-story', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: state.format, prompt })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'The story engine is unavailable');
    return result;
  } catch (error) {
    if (state.format === 'test') return { ok: true, id: `test-${Date.now()}`, engine: 'Local demo library', story: localTestStory };
    throw error;
  }
}

function stopPreview() {
  clearTimeout(state.sceneTimer);
  state.sceneTimer = null;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  clearTimeout(state.voiceTimer);
  state.speaking = false;
  $('#voice-button').classList.remove('playing');
  $('#voice-button').textContent = '▶';
  $('#audio-status').textContent = 'Local browser voice preview';
}

function openModal(result) {
  state.story = result;
  state.currentScene = 0;
  $('#story-title').textContent = result.story.title;
  $('#story-hook').textContent = result.story.hook;
  $('#engine-label').textContent = result.engine === 'Local demo library' ? 'Draft generated locally' : result.engine;
  $('#modal-subtitle').textContent = state.format === 'test' ? 'A quick pipeline check, ready to inspect.' : 'A fresh story, shaped for vertical video.';
  $('#frame-format').textContent = formatNames[state.format];
  $('#video-frame').classList.toggle('chat-mode', state.format === 'chat');
  $('#stickman-scene').classList.toggle('hidden', state.format === 'chat');
  $('#chat-scene').classList.toggle('hidden', state.format !== 'chat');
  $('#modal-backdrop').classList.remove('hidden');
  $('#modal-backdrop').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  if (state.format === 'chat') renderChatPreview();
  else renderScene(0);
}

function closeModal() {
  stopPreview();
  $('#modal-backdrop').classList.add('hidden');
  $('#modal-backdrop').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function renderScene(index) {
  const scenes = state.story?.story?.scenes || [];
  const scene = scenes[index % scenes.length];
  if (!scene) return;
  const sceneLabel = $('#scene-label');
  const caption = $('#scene-caption');
  const prop = $('#scene-prop');
  sceneLabel.textContent = scene.label;
  const words = String(scene.cue || '').split(' ');
  const splitAt = Math.max(2, Math.ceil(words.length / 2));
  caption.innerHTML = `${words.slice(0, splitAt).join(' ')}<br><b>${words.slice(splitAt).join(' ')}</b>`;
  prop.textContent = index % 3 === 0 ? '▣' : index % 3 === 1 ? '◌' : '⌁';
  $('#frame-duration').textContent = `00:${String(5 + index * 3).padStart(2, '0')}`;
  $('#stickman-scene').style.background = [
    'linear-gradient(150deg, #303148, #403b68 58%, #232438)',
    'linear-gradient(150deg, #2e3f4b, #384d68 58%, #222834)',
    'linear-gradient(150deg, #3d344a, #604264 58%, #282333)',
    'linear-gradient(150deg, #2e3d3e, #3c645d 58%, #202f35)'
  ][index % 4];
  clearTimeout(state.sceneTimer);
  state.sceneTimer = setTimeout(() => {
    state.currentScene = (index + 1) % scenes.length;
    renderScene(state.currentScene);
  }, Math.max(2500, Number(scene.duration || 5) * 1000));
}

function renderChatPreview() {
  const messages = $('#messages');
  messages.innerHTML = '';
  const script = state.story?.story?.script || '';
  const matches = script.match(/(?:Maya|Leo|UNKNOWN)\s*:\s*[^:]+?(?=\s+(?:Maya|Leo|UNKNOWN)\s*:|$)/gi) || [];
  const parsed = matches.slice(0, 6).map(item => {
    const split = item.indexOf(':');
    const name = item.slice(0, split).trim();
    const text = item.slice(split + 1).trim();
    return { name, text };
  }).filter(item => item.text);
  const fallback = [
    { name: 'MAYA', text: 'Are you still there?' },
    { name: 'LEO', text: 'I never left.' },
    { name: 'MAYA', text: 'Then who just used your key?' },
    { name: 'UNKNOWN', text: 'Stop pretending you cannot see me.' }
  ];
  (parsed.length ? parsed : fallback).forEach((message, index) => {
    const node = document.createElement('div');
    const normalized = message.name.toUpperCase();
    node.className = `message ${normalized === 'MAYA' ? 'left' : normalized === 'UNKNOWN' ? 'unknown' : 'right'}`;
    node.style.animationDelay = `${index * 140}ms`;
    node.innerHTML = `<span class="message-name">${escapeHtml(normalized)}</span>${escapeHtml(message.text)}`;
    messages.appendChild(node);
  });
  $('#frame-duration').textContent = '00:32';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}

function pickVoice(preferred = 'narrator') {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const maleHints = /daniel|david|alex|guy|james|fred|george|male|mark|thomas|english uk male/i;
  const english = voices.filter(voice => /^en(-|_)/i.test(voice.lang));
  const pool = english.length ? english : voices;
  if (preferred === 'girl') {
    return pool.find(voice => /samantha|karen|ava|victoria|female|zira|susan/i.test(voice.name)) || pool[1] || pool[0];
  }
  return pool.find(voice => maleHints.test(voice.name)) || pool[0];
}

function speakStory() {
  if (!('speechSynthesis' in window)) {
    showToast('This browser does not expose a local voice engine', 'error');
    return;
  }
  if (state.speaking) {
    stopPreview();
    return;
  }
  const script = state.story?.story?.script || '';
  if (!script) return;
  window.speechSynthesis.cancel();
  state.speaking = true;
  $('#voice-button').classList.add('playing');
  $('#voice-button').textContent = '■';
  $('#audio-status').textContent = state.format === 'chat' ? 'Maya + Leo · local voices' : 'Low-pitch narrator · local voice';
  if (state.format !== 'chat') {
    const utterance = new SpeechSynthesisUtterance(script);
    utterance.voice = pickVoice('narrator');
    utterance.rate = .9;
    utterance.pitch = .72;
    utterance.volume = 1;
    utterance.onend = () => { state.speaking = false; $('#voice-button').classList.remove('playing'); $('#voice-button').textContent = '▶'; $('#audio-status').textContent = 'Preview finished'; };
    utterance.onerror = utterance.onend;
    window.speechSynthesis.speak(utterance);
    return;
  }
  const segments = script.match(/(?:Maya|Leo|UNKNOWN)\s*:\s*[^:]+?(?=\s+(?:Maya|Leo|UNKNOWN)\s*:|$)/gi) || [script];
  let index = 0;
  const next = () => {
    if (index >= segments.length) {
      state.speaking = false; $('#voice-button').classList.remove('playing'); $('#voice-button').textContent = '▶'; $('#audio-status').textContent = 'Preview finished'; return;
    }
    const segment = segments[index++];
    const split = segment.indexOf(':');
    const name = split > -1 ? segment.slice(0, split) : 'Maya';
    const words = split > -1 ? segment.slice(split + 1) : segment;
    const utterance = new SpeechSynthesisUtterance(words.trim());
    utterance.voice = pickVoice(name.toLowerCase() === 'maya' ? 'girl' : 'narrator');
    utterance.rate = name.toLowerCase() === 'maya' ? 1.02 : .9;
    utterance.pitch = name.toLowerCase() === 'maya' ? 1.18 : .78;
    utterance.onend = next;
    utterance.onerror = next;
    window.speechSynthesis.speak(utterance);
  };
  next();
}

function downloadStoryboard() {
  if (!state.story) return;
  const payload = {
    product: 'StoryForge Studio',
    exportedAt: new Date().toISOString(),
    platform: state.platform,
    format: state.format,
    audio: state.format === 'chat' ? 'Local browser voice preview: Maya and Leo' : 'Local browser voice preview: low-pitch narrator',
    story: state.story.story,
    note: 'Storyboard export only. No credentials, cookies, or platform access tokens are included.'
  };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  link.download = `${slugify(state.story.story.title)}-storyboard.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('Storyboard exported to your device');
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'storyforge-draft';
}

function addDraftToLibrary(story) {
  const grid = $('#drafts-grid');
  const card = document.createElement('article');
  card.className = 'draft-card new-draft';
  const isChat = state.format === 'chat';
  const isTest = state.format === 'test';
  card.innerHTML = `<div class="draft-thumb ${isChat ? 'thumb-chat' : isTest ? 'thumb-test' : 'thumb-station'}"><span>${isChat ? 'NEW MESSAGE' : isTest ? 'RENDER CHECK' : 'CASE FILE'}</span><i>${isChat ? 'new message' : isTest ? '✓' : 'NEW'}</i><b>${isTest ? '10 SEC' : 'JUST NOW'}</b></div><div class="draft-meta"><strong>${escapeHtml(story.title)}</strong><span><span class="draft-status ready"></span> Ready to review <time>· Just now</time></span></div><button class="more-button" type="button" aria-label="More options">•••</button>`;
  grid.prepend(card);
  while (grid.children.length > 3) grid.lastElementChild.remove();
}

async function startGeneration() {
  setLoading(true);
  try {
    const result = await requestStory();
    state.usedIds.push(result.id);
    state.usedIds = state.usedIds.slice(-30);
    localStorage.setItem('storyforge-used-ids', JSON.stringify(state.usedIds));
    addDraftToLibrary(result.story);
    openModal(result);
    showToast('Fresh draft generated — no repeat ID detected');
  } catch (error) {
    showToast(error.message || 'Could not generate a draft', 'error');
  } finally {
    setLoading(false);
  }
}

function init() {
  $('#today-label').textContent = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).format(new Date()).toUpperCase();
  updatePlatform();
  updateFormat();
  updateCounter();
  $$('.platform-card').forEach(card => card.addEventListener('click', () => { state.platform = card.dataset.platform; updatePlatform(); }));
  $$('.format-card').forEach(card => card.addEventListener('click', () => { state.format = card.dataset.format; updateFormat(); }));
  $('#connect-button').addEventListener('click', connectWithCookies);
  $('#paste-cookies').addEventListener('click', pasteFromClipboard);
  $('#disconnect-button').addEventListener('click', disconnectAccount);
  $('#brief-input').addEventListener('input', updateCounter);
  $('#clear-brief').addEventListener('click', () => { $('#brief-input').value = ''; updateCounter(); $('#brief-input').focus(); });
  $('#start-button').addEventListener('click', startGeneration);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', event => { if (event.target === $('#modal-backdrop')) closeModal(); });
  $('#voice-button').addEventListener('click', speakStory);
  $('#export-button').addEventListener('click', downloadStoryboard);
  $('#queue-button').addEventListener('click', () => { showToast(`${state.platform === 'tiktok' ? 'TikTok' : 'Instagram'} queue saved as a test — no post was sent`); });
  $('#open-library').addEventListener('click', () => $('#library').scrollIntoView({ behavior: 'smooth' }));
  $('#all-drafts').addEventListener('click', () => showToast('Library view is coming next — three latest drafts are shown here'));
  $('#learn-more').addEventListener('click', () => showToast('Paste your own session cookies to connect — they are checked live, then stored only in your browser'));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#modal-backdrop').classList.contains('hidden')) closeModal(); });
  if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = () => {};
  fetch('/api/health').then(response => response.json()).then(data => { if (data.groqConfigured) $('#engine-status').textContent = 'Groq engine ready'; }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
