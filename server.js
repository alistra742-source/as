const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

const fallbackStories = {
  stickman: {
    title: 'The Vanishing at Platform 6',
    hook: 'At 11:47 p.m., one camera went dark for exactly ninety seconds.',
    script: 'At 11:47 p.m., one camera at a quiet train station went dark for exactly ninety seconds. A courier had left a locked case on Platform 6. When the feed returned, the case was gone, but every exit alarm was still green. Investigators mapped the footsteps and found something strange: the trail ended at a wall. The answer was hidden in the station clock. It had been running two minutes slow, giving the thief a tiny window to move through a service door before the system armed. A routine clock check exposed the trick the next morning. No movie getaway, no invisible criminal — just timing, patience, and one overlooked detail.',
    scenes: [
      { label: 'THE HOOK', cue: 'A quiet station. Camera timestamp: 11:47 PM.', duration: 5 },
      { label: 'THE SETUP', cue: 'A courier leaves a locked case on Platform 6.', duration: 7 },
      { label: 'THE GAP', cue: 'The camera blinks out. The alarm stays green.', duration: 7 },
      { label: 'THE CLUE', cue: 'Footsteps stop at a blank wall.', duration: 7 },
      { label: 'THE REVEAL', cue: 'The station clock is two minutes slow.', duration: 8 },
      { label: 'THE TAKEAWAY', cue: 'Timing can hide what a camera misses.', duration: 5 }
    ]
  },
  chat: {
    title: 'Read at 2:13 AM',
    hook: 'Maya: Are you still in the apartment?  Leo: I never left.',
    script: 'Maya: Are you still in the apartment? Leo: I never left. Maya: Then who just used your key? Leo: What do you mean? Maya: The lock turned. I heard your hallway floorboard. Leo: Do not open the door. Maya: I am already in the kitchen. Leo: Maya, I am watching the front door from the cafe. Maya: Then why is someone typing from your bedroom? Leo: Turn off the lights. Maya: Too late. A new message appeared on both phones: Stop pretending you cannot see me. The typing bubble vanished. Then the apartment Wi-Fi disconnected. In the morning, the only clue was a second phone beneath the sofa — still warm, with one unsent message addressed to Maya.',
    scenes: [
      { label: 'MAYA', cue: 'Are you still in the apartment?', duration: 5 },
      { label: 'LEO', cue: 'I never left.', duration: 4 },
      { label: 'MAYA', cue: 'Then who just used your key?', duration: 5 },
      { label: 'LEO', cue: 'Do not open the door.', duration: 5 },
      { label: 'UNKNOWN', cue: 'Stop pretending you cannot see me.', duration: 7 },
      { label: 'THE CLUE', cue: 'A warm phone waits beneath the sofa.', duration: 6 }
    ]
  },
  test: {
    title: 'StoryForge Render Check',
    hook: 'A five-second render test is ready to roll.',
    script: 'This is a StoryForge render check. The scene loader works, the captions are timed, and the preview canvas is ready for your next story. Choose a format, generate a new draft, and use the local voice preview to check the pacing before you export.',
    scenes: [
      { label: 'SCENE 01', cue: 'Render engine online.', duration: 3 },
      { label: 'SCENE 02', cue: 'Captions and motion synced.', duration: 3 },
      { label: 'SCENE 03', cue: 'Ready for your story.', duration: 3 }
    ]
  }
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 32 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}

function fallbackFor(format, prompt) {
  const base = fallbackStories[format] || fallbackStories.test;
  if (format === 'test') return base;
  const cleanPrompt = cleanText(prompt, 100);
  const variants = format === 'stickman'
    ? [
        { title: 'The Photograph with No Shadow', hook: 'The photograph looked ordinary — until investigators noticed one person had no shadow.', script: 'The photograph looked ordinary until investigators noticed one person had no shadow. It came from a charity auction where a valuable painting disappeared between two security checks. Everyone focused on the locked gallery door, but one volunteer remembered the flash. The room had been lit from the left. Every person in the frame should have cast a shadow to the right. The missing shadow belonged to a cardboard cutout, placed in front of the camera while the real person stepped through a staff corridor. The trick was simple, temporary, and caught by one detail the thief never expected anyone to study.', scenes: [{ label: 'THE HOOK', cue: 'One person in the photo has no shadow.', duration: 6 }, { label: 'THE SETUP', cue: 'A painting vanishes between two checks.', duration: 7 }, { label: 'THE DETAIL', cue: 'The flash came from the left.', duration: 6 }, { label: 'THE TRICK', cue: 'A cardboard cutout blocks the camera.', duration: 7 }, { label: 'THE TAKEAWAY', cue: 'Study the ordinary details.', duration: 5 }] },
        { title: 'The Library Card Alibi', hook: 'An alibi looked perfect until a library scanner remembered the exact minute.', script: 'A late-night break-in left no clear footprint and no working camera angle. The person questioned had an airtight alibi: they were at home, reading. Then a library card appeared in the case file. A book had been returned through an outdoor drop box at 12:18 a.m., but the card was scanned from an account that had supposedly stayed home all night. Investigators checked the timing and found the card had been borrowed by someone who knew the library routine. It was not a dramatic confession that solved the case. It was a tiny electronic timestamp that made the story impossible to keep straight.', scenes: [{ label: 'THE HOOK', cue: 'The alibi is perfect — almost.', duration: 6 }, { label: 'THE CLUE', cue: 'A library scanner remembers 12:18 AM.', duration: 7 }, { label: 'THE ALIBI', cue: 'The reader says they never left home.', duration: 7 }, { label: 'THE BREAK', cue: 'The card was borrowed by someone else.', duration: 7 }, { label: 'THE TAKEAWAY', cue: 'Timestamps tell quiet stories.', duration: 5 }] }
      ]
    : [
        { title: 'The Message That Arrived Tomorrow', hook: 'Maya: Why did you send me a message dated tomorrow?', script: 'Maya: Why did you send me a message dated tomorrow? Leo: I did not. Maya: It says, Do not answer the next call. Leo: Put your phone on airplane mode. Maya: The message is changing. Leo: What does it say now? Maya: It says you are already outside. Leo: Maya, I am still in the cafe. Maya: Then who just knocked? The typing bubble appeared beneath Leo’s name, even though Leo’s phone was face down on the cafe table. One final message arrived from an unsaved number: Wrong timeline. The chat disappeared when the clock struck midnight, leaving only a screenshot Maya had taken before she opened the door.', scenes: [{ label: 'MAYA', cue: 'Why did you send me a message dated tomorrow?', duration: 6 }, { label: 'LEO', cue: 'I did not. Put your phone on airplane mode.', duration: 6 }, { label: 'MAYA', cue: 'The message is changing.', duration: 5 }, { label: 'UNKNOWN', cue: 'Wrong timeline.', duration: 7 }, { label: 'THE CLUE', cue: 'The screenshot survives midnight.', duration: 6 }] },
        { title: 'Typing from the Empty Room', hook: 'The message showed as read from a room no one had entered.', script: 'Maya: Did you leave your laptop open? Leo: No. I am on the train. Maya: It just sent me a photo. Leo: Do not click it. Maya: Too late. It is our hallway, but the lights are off. Leo: Is someone in the apartment? Maya: The typing dots are back. Leo: Call me. Maya: I am calling. Why is your phone answering from the spare room? Leo: I only have one phone. Maya: Then who is whispering my name? The chat froze on a single green check. When Leo returned, the laptop was closed, but its camera light was still glowing.', scenes: [{ label: 'MAYA', cue: 'Did you leave your laptop open?', duration: 6 }, { label: 'LEO', cue: 'No. I am on the train.', duration: 6 }, { label: 'THE PHOTO', cue: 'The hallway is dark, but the camera is live.', duration: 7 }, { label: 'THE CALL', cue: 'A phone answers from the spare room.', duration: 7 }, { label: 'THE CLUE', cue: 'The camera light is still glowing.', duration: 6 }] }
      ];
  const index = Math.abs([...cleanPrompt].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % variants.length;
  const variant = variants[index];
  return {
    ...variant,
    hook: `${variant.hook} Brief: ${cleanPrompt.slice(0, 70)}`
  };
}

async function generateWithGroq(format, prompt) {
  if (!process.env.GROQ_API_KEY) return null;
  const request = {
    model: GROQ_MODEL,
    temperature: 0.88,
    max_tokens: 850,
    messages: [
      {
        role: 'system',
        content: format === 'chat'
          ? 'You write short fictional suspense stories for vertical social video. Return strict JSON with keys title, hook, script, scenes. The script should take 30 to 45 seconds to read and be a clean messenger exchange between Maya and Leo plus one UNKNOWN sender. Keep it non-graphic, original, and suitable for a general audience. scenes must be an array of 5 to 7 objects with label, cue, and duration number.'
          : 'You write concise documentary-style crime stories for vertical social video. Return strict JSON with keys title, hook, script, scenes. The script should take 40 to 60 seconds to read, be non-graphic, avoid naming private people, avoid instructions that enable wrongdoing, and clearly frame uncertain details as reported or alleged. scenes must be an array of 5 to 7 objects with label, cue, and duration number.'
      },
      {
        role: 'user',
        content: `Create one original ${format === 'chat' ? 'faceless messenger suspense' : 'stickman crime'} story. Creative brief: ${cleanText(prompt || 'an overlooked detail that solved a mystery', 300)}`
      }
    ]
  };

  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify(request)
  });
  if (!response.ok) throw new Error(`Groq request failed with ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '';
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Groq returned an unexpected response');
  const parsed = JSON.parse(match[0]);
  if (!parsed.title || !parsed.script || !Array.isArray(parsed.scenes)) throw new Error('Groq response was incomplete');
  return {
    title: cleanText(parsed.title, 90),
    hook: cleanText(parsed.hook || parsed.script.slice(0, 120), 180),
    script: cleanText(parsed.script, 2400),
    scenes: parsed.scenes.slice(0, 8).map(scene => ({
      label: cleanText(scene.label || 'SCENE', 32).toUpperCase(),
      cue: cleanText(scene.cue || '', 150),
      duration: Math.max(3, Math.min(12, Number(scene.duration) || 5))
    }))
  };
}

function safeFilePath(urlPath) {
  const pathname = decodeURIComponent(urlPath.split('?')[0]);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const absolute = path.normalize(path.join(PUBLIC_DIR, requested));
  return absolute.startsWith(PUBLIC_DIR) ? absolute : null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, groqConfigured: Boolean(process.env.GROQ_API_KEY) });
  }

  if (url.pathname === '/api/generate-story' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const format = ['stickman', 'chat', 'test'].includes(body.format) ? body.format : 'test';
      let story = null;
      let engine = 'Local demo library';
      if (format !== 'test' && process.env.GROQ_API_KEY) {
        try {
          story = await generateWithGroq(format, body.prompt);
          engine = `Groq · ${GROQ_MODEL}`;
        } catch (error) {
          console.error(error.message);
        }
      }
      story = story || fallbackFor(format, body.prompt);
      return json(res, 200, {
        ok: true,
        id: crypto.randomUUID(),
        engine,
        generatedAt: new Date().toISOString(),
        story
      });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const filePath = safeFilePath(url.pathname);
  if (!filePath) return json(res, 403, { ok: false, error: 'Forbidden' });
  fs.readFile(filePath, (error, content) => {
    if (error) return json(res, 404, { ok: false, error: 'Not found' });
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600' });
    if (req.method !== 'HEAD') res.end(content); else res.end();
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(error);
    json(res, 500, { ok: false, error: 'Unexpected server error' });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`StoryForge Studio listening on 0.0.0.0:${PORT}`);
  console.log(`Groq story engine: ${process.env.GROQ_API_KEY ? 'configured' : 'local demo fallback'}`);
});
