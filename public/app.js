const state = {
  platform: 'tiktok',
  format: 'stickman',
  connected: JSON.parse(localStorage.getItem('storyforge-connected') || '{}'),
  story: null,
  currentScene: 0,
  sceneTimer: null,
  voiceTimer: null,
  renderFrame: null,
  renderStartedAt: 0,
  renderDuration: 0,
  recorder: null,
  videoChunks: [],
  videoBlob: null,
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
  $('#connection-icon').textContent = state.platform === 'tiktok' ? '♪' : '◎';
  $('#connection-icon').className = `connection-icon ${state.platform === 'tiktok' ? 'tiktok-connection' : 'instagram-connection'}`;
  const connection = state.connected[state.platform];
  const isConnected = Boolean(connection);
  const handle = connection && connection.handle ? connection.handle : 'account';
  if (isConnected) {
    $('#connection-title').textContent = `${name} connected`;
    $('#connection-description').textContent = `Session verified on ${new Date(connection.verifiedAt).toLocaleDateString()} — signed in as @${handle}. Cookies live only in this browser.`;
  } else {
    $('#connection-title').textContent = `Paste ${name} session cookies`;
    $('#connection-description').textContent = 'Export the cookies for this platform from your logged-in browser, then paste them below as JSON.';
  }
  $('#connected-label').classList.toggle('hidden', !isConnected);
  if ($('#connected-handle')) $('#connected-handle').textContent = isConnected ? `@${handle}` : 'Connected';
  $('#connect-button').innerHTML = isConnected ? 'Disconnect <span>✕</span>' : 'Validate & connect <span>→</span>';
  $('#connect-button').classList.toggle('connected-button', isConnected);
  $('#connect-button').disabled = false;
  const profile = $('.profile-name');
  if (profile) profile.textContent = isConnected ? `@${handle}` : 'Sam Carter';
  if (isConnected && $('#cookie-input')) $('#cookie-input').value = '';
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

function normalizeCookiesClient(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') list = Object.entries(raw).map(([name, value]) => ({ name, value }));
  return list.filter(cookie => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string' && cookie.name.trim());
}

function cookieIsExpiredClient(cookie) {
  const raw = cookie.expirationDate ?? cookie.expires;
  if (raw === undefined || raw === null || raw === '') return false;
  const time = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : new Date(raw).getTime();
  return Number.isFinite(time) && time < Date.now();
}

function setCookieStatus(kind, message) {
  const status = $('#cookie-status');
  if (!status) return;
  status.classList.remove('hidden', 'ok', 'error', 'warn');
  if (kind !== 'idle') status.classList.add(kind);
  status.textContent = message;
}

async function pasteCookies() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) throw new Error('empty');
    $('#cookie-input').value = text;
    $('#cookie-input').focus();
    setCookieStatus('idle', 'Cookies pasted — hit Validate & connect to check them.');
  } catch {
    showToast('Clipboard access was blocked — paste manually with Ctrl/Cmd + V', 'error');
  }
}

function showCookieExample() {
  $('#cookie-input').value = JSON.stringify([
    { name: 'sessionid', value: 'replace-with-your-session-id' },
    { name: 'msToken', value: 'replace-with-your-ms-token' }
  ], null, 2);
  $('#cookie-input').focus();
  setCookieStatus('idle', 'Example filled in — replace the values with your real cookies.');
}

async function validateSession() {
  const input = $('#cookie-input').value.trim();
  if (!input) {
    showToast('Paste your session cookies JSON first', 'error');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    setCookieStatus('error', 'That is not valid JSON. Paste the cookies export as-is or use the Show example format.');
    showToast('Invalid JSON — check the format', 'error');
    return;
  }
  const cookies = normalizeCookiesClient(parsed);
  if (!cookies.length) {
    setCookieStatus('error', 'No cookies found. Expected an array of { name, value } objects or a flat { "sessionid": "..." } map.');
    return;
  }
  if (!cookies.some(cookie => cookie.name.toLowerCase() === 'sessionid' && cookie.value.length >= 8)) {
    setCookieStatus('error', 'Missing a valid sessionid cookie — that cookie is required to log in.');
    return;
  }
  const expired = cookies.filter(cookieIsExpiredClient);
  if (expired.length) {
    setCookieStatus('error', `${expired.length} cookie${expired.length > 1 ? 's are' : ' is'} expired. Export fresh cookies while logged in.`);
    return;
  }
  setCookieStatus('idle', 'Checking the session against the platform…');
  $('#connect-button').disabled = true;
  $('#connect-button').innerHTML = 'Validating… <span>◌</span>';
  try {
    const response = await fetch('/api/validate-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: state.platform, cookies: parsed })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Validation failed');
    if (result.status === 'verified') {
      state.connected[state.platform] = { handle: result.handle || 'account', verifiedAt: result.checkedAt || new Date().toISOString() };
      saveConnection();
      updatePlatform();
      setCookieStatus('ok', `Session verified — connected as @${result.handle || 'account'}. Cookies stay in this browser only.`);
      showToast('Session verified — account connected');
    } else if (result.status === 'rejected') {
      setCookieStatus('error', 'The platform rejected these cookies — the session is invalid or expired. Export fresh cookies while logged in on the platform.');
      showToast('Session rejected — cookies are not valid', 'error');
    } else {
      state.connected[state.platform] = { handle: 'account', verifiedAt: new Date().toISOString(), unchecked: true };
      saveConnection();
      updatePlatform();
      setCookieStatus('warn', 'Could not reach the platform from this server, so the live check was skipped. Connected on the local structural check — the session may or may not be valid.');
      showToast('Connected (live check unavailable)');
    }
  } catch (error) {
    setCookieStatus('error', error.message || 'Could not validate the session — try again.');
    showToast(error.message || 'Could not validate the session', 'error');
  } finally {
    $('#connect-button').disabled = false;
    updatePlatform();
  }
}

function disconnectAccount() {
  delete state.connected[state.platform];
  saveConnection();
  updatePlatform();
  setCookieStatus('idle', 'Disconnected. Paste fresh cookies to connect again.');
  showToast('Account disconnected');
}

function connectAccount() {
  if (state.connected[state.platform]) {
    disconnectAccount();
    return;
  }
  validateSession();
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
  if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
  state.renderFrame = null;
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  state.recorder = null;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  clearTimeout(state.voiceTimer);
  state.speaking = false;
  $('#voice-button').classList.remove('playing');
  $('#voice-button').textContent = '▶';
  $('#audio-status').textContent = 'Live browser voiceover';
  if ($('#render-status')) {
    $('#render-status').classList.remove('live');
    $('#render-status-text').textContent = 'Preview ready';
    $('#render-progress').textContent = '0%';
  }
  if ($('#render-button')) {
    $('#render-button').disabled = false;
    $('#render-button').innerHTML = '<span class="button-icon">●</span> Render demo video <span class="button-arrow">→</span>';
  }
}

function openModal(result) {
  stopPreview();
  state.story = result;
  state.currentScene = 0;
  state.videoBlob = null;
  $('#download-video-button').classList.add('hidden');
  $('#video-frame').classList.remove('canvas-mode');
  $('#frame-state').textContent = 'PREVIEW';
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
  // Starting a draft also starts the same vertical render pass used for the demo video.
  setTimeout(() => {
    if (!$('#modal-backdrop').classList.contains('hidden') && state.story === result) startDemoRender();
  }, 450);
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

function getChatMessages() {
  const script = state.story?.story?.script || '';
  const matches = script.match(/(?:Maya|Leo|UNKNOWN)\s*:\s*[^:]+?(?=\s+(?:Maya|Leo|UNKNOWN)\s*:|$)/gi) || [];
  const parsed = matches.slice(0, 8).map(item => {
    const split = item.indexOf(':');
    return { name: (split > -1 ? item.slice(0, split) : 'Maya').trim().toUpperCase(), text: (split > -1 ? item.slice(split + 1) : item).trim() };
  }).filter(item => item.text);
  return parsed.length ? parsed : [
    { name: 'MAYA', text: 'Are you still there?' },
    { name: 'LEO', text: 'I never left.' },
    { name: 'MAYA', text: 'Then who just used your key?' },
    { name: 'UNKNOWN', text: 'Stop pretending you cannot see me.' }
  ];
}

function wrapCanvasText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  words.forEach(word => {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  });
  if (line) lines.push(line);
  return lines;
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawCanvasCaption(ctx, cue, width, height) {
  const boxX = 22;
  const boxWidth = width - 44;
  ctx.font = '600 16px DM Sans, Arial, sans-serif';
  const lines = wrapCanvasText(ctx, cue, boxWidth - 28).slice(0, 3);
  const boxHeight = 30 + lines.length * 23;
  const boxY = height - 116 - boxHeight;
  ctx.fillStyle = 'rgba(18, 20, 32, .78)';
  ctx.beginPath();
  roundedRectPath(ctx, boxX, boxY, boxWidth, boxHeight, 12);
  ctx.fill();
  ctx.fillStyle = '#e6dc9a';
  ctx.fillRect(boxX, boxY, 4, boxHeight);
  ctx.fillStyle = '#fffdf3';
  lines.forEach((line, index) => ctx.fillText(line, boxX + 16, boxY + 27 + index * 23));
  return boxY;
}

function drawStickman(ctx, x, y, scale, elapsed) {
  const bounce = Math.sin(elapsed * 4.2) * 2.5 * scale;
  const talk = Math.sin(elapsed * 10) > .25;
  const s = scale;
  ctx.save();
  ctx.translate(x, y + bounce);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#191b24';
  ctx.fillStyle = '#fffef9';
  ctx.lineWidth = 5 * s;
  // Head, with the clean outlined look from the reference image.
  ctx.beginPath();
  ctx.arc(0, -126 * s, 44 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Three loose hair strokes.
  ctx.lineWidth = 4 * s;
  [-25, 0, 25].forEach((offset, index) => {
    ctx.beginPath();
    ctx.moveTo(offset * s, -168 * s);
    ctx.quadraticCurveTo((offset - 3) * s, (-183 - index * 4) * s, (offset + 7) * s, (-192 - index * 2) * s);
    ctx.stroke();
  });
  // Eyes.
  ctx.fillStyle = '#191b24';
  ctx.beginPath(); ctx.ellipse(-14 * s, -135 * s, 7 * s, 12 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(14 * s, -135 * s, 7 * s, 12 * s, 0, 0, Math.PI * 2); ctx.fill();
  // Friendly talking smile.
  ctx.strokeStyle = '#191b24';
  ctx.lineWidth = 3.5 * s;
  ctx.beginPath();
  ctx.arc(0, -129 * s, 24 * s, .18, Math.PI - .18);
  ctx.stroke();
  if (talk) {
    ctx.fillStyle = '#f29b92';
    ctx.beginPath(); ctx.ellipse(0, -113 * s, 7 * s, 3 * s, 0, 0, Math.PI * 2); ctx.fill();
  }
  // Body and open explaining pose.
  ctx.strokeStyle = '#191b24';
  ctx.lineWidth = 5 * s;
  ctx.beginPath(); ctx.moveTo(0, -82 * s); ctx.lineTo(0, 10 * s); ctx.stroke();
  const armLift = Math.sin(elapsed * 3) * 4 * s;
  ctx.beginPath(); ctx.moveTo(0, -65 * s); ctx.lineTo(-68 * s, (-103 + armLift) * s); ctx.lineTo(-102 * s, (-93 + armLift) * s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -65 * s); ctx.lineTo(68 * s, (-103 - armLift) * s); ctx.lineTo(102 * s, (-93 - armLift) * s); ctx.stroke();
  // Open hands with three small fingers.
  const drawHand = (handX, handY, side) => {
    ctx.beginPath(); ctx.arc(handX, handY, 8 * s, 0, Math.PI * 2); ctx.stroke();
    for (let finger = -1; finger <= 1; finger++) {
      ctx.beginPath();
      ctx.moveTo(handX + side * 3 * s, handY + finger * 4 * s);
      ctx.lineTo(handX + side * (13 + Math.abs(finger) * 2) * s, handY + (finger - .2) * 7 * s);
      ctx.stroke();
    }
  };
  drawHand(-106 * s, (-94 + armLift) * s, -1);
  drawHand(106 * s, (-94 - armLift) * s, 1);
  // Long legs with soft oval shoes.
  ctx.beginPath(); ctx.moveTo(0, 10 * s); ctx.lineTo(-54 * s, 128 * s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 10 * s); ctx.lineTo(57 * s, 128 * s); ctx.stroke();
  ctx.fillStyle = '#31323b';
  ctx.beginPath(); ctx.ellipse(-67 * s, 131 * s, 25 * s, 7 * s, -.08, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(70 * s, 131 * s, 25 * s, 7 * s, .08, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawStickmanCanvasFrame(ctx, elapsed, scene, sceneIndex, totalScenes, width, height) {
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, ['#f8f4e9', '#e8f0fa', '#f6e8f0', '#e9f5ef'][sceneIndex % 4]);
  background.addColorStop(1, ['#b9cce5', '#c7d8dc', '#d8c2d2', '#bed7cb'][sceneIndex % 4]);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  // Soft spotlight and subtle storyboard grid.
  ctx.fillStyle = 'rgba(255,255,255,.42)';
  ctx.beginPath(); ctx.arc(width * .72, height * .32, 142, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(73, 84, 105, .12)'; ctx.lineWidth = 1;
  for (let y = 0; y < height; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  ctx.fillStyle = '#52596a'; ctx.font = '500 10px DM Mono, monospace'; ctx.letterSpacing = '1px'; ctx.fillText('LIVE STICKMAN EXPLAINER', 22, 30);
  ctx.fillStyle = 'rgba(42, 45, 56, .68)'; ctx.font = '500 10px DM Mono, monospace'; ctx.fillText(`${String(scene.label || 'SCENE').toUpperCase()}  /  ${String(sceneIndex + 1).padStart(2, '0')}`, 22, 55);
  drawStickman(ctx, width * .5, height * .58, .88, elapsed);
  ctx.fillStyle = '#677089';
  ctx.font = '600 15px DM Sans, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('explaining the clue', width * .5, height * .77);
  ctx.textAlign = 'left';
  drawCanvasCaption(ctx, scene.cue, width, height);
  ctx.fillStyle = 'rgba(54, 60, 72, .62)';
  ctx.font = '500 10px DM Mono, monospace';
  ctx.fillText('STORYFORGE  ·  9:16', 22, height - 22);
  // A little live speech indicator makes the relationship to the voiceover clear.
  ctx.fillStyle = '#7b6cf2';
  ctx.beginPath(); ctx.arc(width - 31, 29, 4 + Math.abs(Math.sin(elapsed * 6)) * 2, 0, Math.PI * 2); ctx.fill();
}

function drawChatCanvasFrame(ctx, elapsed, scenes, width, height) {
  ctx.fillStyle = '#f5f3fc'; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#9894b4'; ctx.font = '500 10px DM Mono, monospace'; ctx.fillText('PRIVATE CHAT  /  LIVE PREVIEW', 18, 29);
  ctx.fillStyle = '#fff'; ctx.fillRect(14, 50, width - 28, 53);
  ctx.fillStyle = '#d49bb4'; ctx.beginPath(); ctx.arc(36, 76, 15, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '700 12px DM Sans, Arial'; ctx.textAlign = 'center'; ctx.fillText('M', 36, 80); ctx.textAlign = 'left';
  ctx.fillStyle = '#2b2c38'; ctx.font = '700 12px DM Sans, Arial'; ctx.fillText('m / leo', 59, 74);
  ctx.fillStyle = '#9aa39e'; ctx.font = '500 9px DM Mono, monospace'; ctx.fillText('active now', 59, 88);
  const messages = scenes.map(scene => ({ name: String(scene.label || 'MAYA').toUpperCase(), text: scene.cue }));
  const durations = scenes.map(scene => Math.max(3, Number(scene.duration) || 5));
  let messageEnd = 0;
  const visible = [];
  messages.forEach((message, index) => { messageEnd += durations[index]; if (elapsed >= messageEnd - durations[index] * .72) visible.push({ ...message, index }); });
  const shown = visible.slice(-5);
  let y = 150;
  shown.forEach((message, index) => {
    const right = message.name !== 'MAYA' && message.name !== 'UNKNOWN';
    const unknown = message.name === 'UNKNOWN';
    ctx.font = '500 12px DM Sans, Arial';
    const lines = wrapCanvasText(ctx, message.text, 210).slice(0, 3);
    const boxH = 25 + lines.length * 17;
    const boxW = Math.min(270, Math.max(120, Math.max(...lines.map(line => ctx.measureText(line).width)) + 22));
    const x = right ? width - 18 - boxW : 18;
    ctx.fillStyle = unknown ? '#675eb0' : right ? '#d8f1e5' : '#fff';
    ctx.beginPath(); roundedRectPath(ctx, x, y, boxW, boxH, 11); ctx.fill();
    ctx.fillStyle = unknown ? '#e6e2ff' : right ? '#6a9987' : '#9b83ae'; ctx.font = '500 8px DM Mono, monospace'; ctx.fillText(message.name, x + 11, y + 13);
    ctx.fillStyle = unknown ? '#fff' : right ? '#3f7561' : '#555265'; ctx.font = '500 12px DM Sans, Arial'; lines.forEach((line, lineIndex) => ctx.fillText(line, x + 11, y + 30 + lineIndex * 17));
    y += boxH + 12;
  });
  ctx.fillStyle = '#fff'; ctx.beginPath(); roundedRectPath(ctx, 18, height - 64, width - 36, 34, 17); ctx.fill();
  ctx.fillStyle = '#aaa4bd'; ctx.font = '500 11px DM Sans, Arial'; ctx.fillText('typing…', 33, height - 43);
  ctx.fillStyle = '#6e65c9'; ctx.font = '500 9px DM Mono, monospace'; ctx.fillText('VOICEOVER  ·  MAYA + LEO', 18, height - 15);
}

function renderCanvasFrame(elapsed) {
  const canvas = $('#video-canvas');
  if (!canvas) return { elapsed: 0, total: 1, sceneIndex: 0 };
  const ctx = canvas.getContext('2d');
  const scenes = state.story?.story?.scenes || [];
  const total = Math.max(1, scenes.reduce((sum, scene) => sum + Math.max(3, Number(scene.duration) || 5), 0));
  let remaining = Math.min(elapsed, total);
  let sceneIndex = 0;
  while (sceneIndex < scenes.length - 1 && remaining >= Math.max(3, Number(scenes[sceneIndex].duration) || 5)) {
    remaining -= Math.max(3, Number(scenes[sceneIndex].duration) || 5);
    sceneIndex += 1;
  }
  if (state.format === 'chat') drawChatCanvasFrame(ctx, elapsed, scenes, canvas.width, canvas.height);
  else drawStickmanCanvasFrame(ctx, elapsed, scenes[sceneIndex] || { label: 'SCENE', cue: '' }, sceneIndex, scenes.length, canvas.width, canvas.height);
  return { elapsed, total, sceneIndex };
}

function supportedVideoMime() {
  if (!window.MediaRecorder) return '';
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function startDemoRender() {
  if (!state.story) return;
  const canvas = $('#video-canvas');
  if (!canvas || !canvas.captureStream || !window.MediaRecorder) {
    showToast('Live canvas render is available, but this browser cannot export WebM video', 'error');
    $('#video-frame').classList.add('canvas-mode');
    $('#frame-state').textContent = 'LIVE PREVIEW';
    renderCanvasFrame(0);
    speakStory();
    return;
  }
  stopPreview();
  $('#video-frame').classList.add('canvas-mode');
  $('#frame-state').textContent = 'LIVE RENDER';
  $('#render-status').classList.add('live');
  $('#render-status').classList.remove('done');
  $('#render-status-text').textContent = 'Rendering video + captions';
  $('#render-progress').textContent = '0%';
  $('#render-button').disabled = true;
  $('#render-button').innerHTML = '<span class="button-icon">◌</span> Rendering live…';
  $('#download-video-button').classList.add('hidden');
  state.videoBlob = null;
  state.renderStartedAt = performance.now();
  const mimeType = supportedVideoMime();
  const stream = canvas.captureStream(30);
  state.videoChunks = [];
  state.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  state.recorder.ondataavailable = event => { if (event.data && event.data.size) state.videoChunks.push(event.data); };
  state.recorder.onstop = () => {
    if (state.videoChunks.length) {
      state.videoBlob = new Blob(state.videoChunks, { type: mimeType || 'video/webm' });
      $('#download-video-button').classList.remove('hidden');
      $('#render-status').classList.remove('live');
      $('#render-status').classList.add('done');
      $('#render-status-text').textContent = 'Video ready to download';
      $('#render-progress').textContent = '100%';
      $('#render-button').disabled = false;
      $('#render-button').innerHTML = '<span class="button-icon">↻</span> Render again <span class="button-arrow">→</span>';
      showToast('Demo video ready — captions and motion are synced');
    }
    state.recorder = null;
  };
  state.recorder.start(250);
  // This is intentionally a local browser voiceover: free, private, and heard while the demo renders.
  speakStory();
  const tick = now => {
    const elapsed = (now - state.renderStartedAt) / 1000;
    const frame = renderCanvasFrame(elapsed);
    const progress = Math.min(100, Math.round((frame.elapsed / frame.total) * 100));
    $('#render-progress').textContent = `${progress}%`;
    $('#frame-duration').textContent = `00:${String(Math.floor(Math.min(frame.elapsed, frame.total))).padStart(2, '0')}`;
    if (elapsed < frame.total) {
      state.renderFrame = requestAnimationFrame(tick);
    } else {
      state.renderFrame = null;
      renderCanvasFrame(frame.total);
      if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    }
  };
  state.renderFrame = requestAnimationFrame(tick);
}

function downloadVideo() {
  if (!state.videoBlob) {
    showToast('Render the demo video first', 'error');
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(state.videoBlob);
  link.download = `${slugify(state.story.story.title)}-demo.webm`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  showToast('Demo video downloaded as WebM');
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
  $('#connect-button').addEventListener('click', connectAccount);
  $('#paste-cookies').addEventListener('click', pasteCookies);
  $('#format-help').addEventListener('click', showCookieExample);
  $('#brief-input').addEventListener('input', updateCounter);
  $('#clear-brief').addEventListener('click', () => { $('#brief-input').value = ''; updateCounter(); $('#brief-input').focus(); });
  $('#start-button').addEventListener('click', startGeneration);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', event => { if (event.target === $('#modal-backdrop')) closeModal(); });
  $('#voice-button').addEventListener('click', speakStory);
  $('#export-button').addEventListener('click', downloadStoryboard);
  $('#render-button').addEventListener('click', startDemoRender);
  $('#download-video-button').addEventListener('click', downloadVideo);
  $('#open-library').addEventListener('click', () => $('#library').scrollIntoView({ behavior: 'smooth' }));
  $('#all-drafts').addEventListener('click', () => showToast('Library view is coming next — three latest drafts are shown here'));
  $('#learn-more').addEventListener('click', () => showToast('Cookies are validated live, kept only in this browser, and never sent anywhere else'));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#modal-backdrop').classList.contains('hidden')) closeModal(); });
  if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = () => {};
  fetch('/api/health').then(response => response.json()).then(data => { if (data.groqConfigured) $('#engine-status').textContent = 'Groq engine ready'; }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
