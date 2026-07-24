const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

require('dotenv').config();

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const dataFile = path.resolve(process.env.DATA_FILE || path.join(__dirname, 'data', 'storage.json'));
const publicDir = path.join(__dirname, 'public');
const maxStoredValueBytes = Number(process.env.MAX_STORED_VALUE_BYTES || 1_000_000);
const aiProvider = String(process.env.AI_PROVIDER || (process.env.YUNWU_API_KEY ? 'yunwu' : 'anthropic')).toLowerCase();

let storeCache = null;
let writeQueue = Promise.resolve();
const aiHitsByIp = new Map();
let aiGlobalHits = [];

app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));

function isValidKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 220 && /^[a-zA-Z0-9:_./-]+$/.test(key);
}

function jsonSize(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

/* mirrors the production worker: game content keys are ownership-protected */
const PROTECTED_KEY = /^ra-(meta|code)-/;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function isEngagementOnlyChange(oldStr, newStr) {
  let a;
  let b;
  try {
    a = JSON.parse(oldStr);
    b = JSON.parse(newStr);
  } catch (error) {
    return false;
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  const allowed = new Set(['plays', 'recentPlays', 'playLog', 'likedBy', 'likes', 'comments', 'cover']);
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const field of fields) {
    if (allowed.has(field) || field.startsWith('_')) continue;
    const oldValue = a[field] === undefined ? null : a[field];
    const newValue = b[field] === undefined ? null : b[field];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) return false;
  }
  if (!Number.isFinite(Number(b.plays)) || Number(b.plays) < 0 || Number(b.plays) > 1_000_000_000) return false;
  if (b.recentPlays !== undefined && (!Array.isArray(b.recentPlays) || b.recentPlays.length > 300)) return false;
  if (b.playLog !== undefined && (!Array.isArray(b.playLog) || b.playLog.length > 20)) return false;
  if (b.likedBy !== undefined && (!Array.isArray(b.likedBy) || b.likedBy.length > 40)) return false;
  if (b.comments !== undefined) {
    if (!Array.isArray(b.comments) || b.comments.length > 100) return false;
    for (const comment of b.comments) {
      if (!comment || typeof comment !== 'object') return false;
      if (typeof comment.by !== 'string' || comment.by.length > 24) return false;
      if (typeof comment.text !== 'string' || !comment.text.trim() || comment.text.length > 240) return false;
      if (!Number.isFinite(Number(comment.t))) return false;
    }
  }
  if (a.cover && b.cover !== a.cover) return false;
  if (!a.cover && b.cover !== undefined && (typeof b.cover !== 'string' || b.cover.length > 950_000)) return false;
  return true;
}

async function readStore() {
  if (storeCache) return storeCache;
  try {
    const raw = await fs.readFile(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    storeCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read storage file:', error.message);
    storeCache = {};
  }
  if (!storeCache.shared || typeof storeCache.shared !== 'object') storeCache.shared = {};
  if (!storeCache.owners || typeof storeCache.owners !== 'object') storeCache.owners = {};
  return storeCache;
}

async function writeStore(mutator) {
  writeQueue = writeQueue.then(async () => {
    const store = await readStore();
    await mutator(store);
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    const tmp = `${dataFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fs.rename(tmp, dataFile);
  });
  return writeQueue;
}

function checkAiLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const hourlyWindowMs = 60 * 60 * 1000;
  const dailyWindowMs = 24 * 60 * 60 * 1000;
  const ipLimit = Number(process.env.AI_REQUESTS_PER_IP_PER_HOUR || process.env.AI_REQUESTS_PER_HOUR || 20);
  const globalLimit = Number(process.env.AI_REQUESTS_GLOBAL_PER_DAY || 120);
  const hits = (aiHitsByIp.get(ip) || []).filter((t) => now - t < hourlyWindowMs);
  aiGlobalHits = aiGlobalHits.filter((t) => now - t < dailyWindowMs);

  if (Number.isFinite(ipLimit) && ipLimit > 0 && hits.length >= ipLimit) {
    return res.status(429).json({ error: 'Too many AI requests. Please try again later.' });
  }

  if (Number.isFinite(globalLimit) && globalLimit > 0 && aiGlobalHits.length >= globalLimit) {
    return res.status(429).json({ error: 'The beta AI budget is paused for today. Please try again tomorrow.' });
  }

  hits.push(now);
  aiGlobalHits.push(now);
  aiHitsByIp.set(ip, hits);
  return next();
}

function getMaxTokens(value) {
  const requestedMaxTokens = Number(value || 4096);
  const maxAllowedTokens = Number(process.env.AI_MAX_TOKENS || 8000);
  return Math.max(1, Math.min(requestedMaxTokens, maxAllowedTokens));
}

function cleanAiRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 8) : [];
  const effort = process.env.AI_EFFORT || process.env.CLAUDE_EFFORT || '';

  const request = {
    model: body.model,
    modelTier: body.modelTier === '3d' ? '3d' : 'default',
    max_tokens: getMaxTokens(body.max_tokens),
    stream: Boolean(body.stream),
    system: typeof body.system === 'string' ? body.system.slice(0, 80_000) : '',
    messages
  };

  if (effort) request.effort = effort;
  return request;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return '';
      return typeof part.text === 'string' ? part.text : '';
    }).join('');
  }
  return '';
}

function toOpenAiMessages(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = textFromContent(message.content).slice(0, 120_000);
    if (content) messages.push({ role, content });
  }
  return messages;
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || 'https://yunwu.ai/v1').replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function anthropicModel() {
  return process.env.ANTHROPIC_MODEL || process.env.AI_MODEL || 'claude-sonnet-5';
}

function yunwuModel(modelTier) {
  return modelTier === '3d'
    ? (process.env.YUNWU_3D_MODEL || 'gpt-5.6-sol')
    : (process.env.YUNWU_MODEL || process.env.AI_MODEL || 'gpt-4o-mini');
}

function metaModel() {
  return process.env.META_MODEL || process.env.AI_MODEL || 'muse-spark-1.1';
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamOpenAiAsAnthropic(upstream, res) {
  if (!upstream.ok) {
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    if (!upstream.body) return res.end();
    return Readable.fromWeb(upstream.body).pipe(res);
  }

  res.status(200);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('x-accel-buffering', 'no');

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingRead = reader.read();

  while (true) {
    const next = await Promise.race([
      pendingRead.then((result) => ({ result })),
      new Promise((resolve) => setTimeout(() => resolve({ heartbeat: true }), 10_000))
    ]);
    if (next.heartbeat) {
      res.write(': keepalive\n\n');
      continue;
    }
    const { value, done } = next.result;
    if (done) break;
    pendingRead = reader.read();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      if (event.error) {
        const message = typeof event.error === 'string'
          ? event.error
          : (event.error.message || event.error.code || 'The AI provider stopped the request.');
        sendSse(res, { type: 'error', error: { code: 'provider_error', message } });
        continue;
      }

      const choices = event.choices || [];
      const refusal = choices.map((choice) => {
        return choice && choice.delta && typeof choice.delta.refusal === 'string' ? choice.delta.refusal : '';
      }).join('');
      if (refusal) {
        sendSse(res, { type: 'error', error: { code: 'provider_refusal', message: 'The AI provider refused this prompt.' } });
        continue;
      }

      const finishReason = choices.map((choice) => choice && choice.finish_reason).find(Boolean);
      if (finishReason === 'content_filter') {
        sendSse(res, { type: 'error', error: { code: 'content_filter', message: 'The AI provider stopped this prompt because of its content policy.' } });
        continue;
      }
      if (finishReason) sendSse(res, { type: 'message_delta', delta: { stop_reason: finishReason } });

      const text = choices.map((choice) => {
        return choice && choice.delta && typeof choice.delta.content === 'string' ? choice.delta.content : '';
      }).join('');

      if (text) {
        sendSse(res, { type: 'content_block_delta', delta: { type: 'text_delta', text } });
      }
    }
  }

  res.write('data: [DONE]\n\n');
  return res.end();
}

async function callAnthropic(body, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01'
    },
    body: JSON.stringify({ ...body, model: anthropicModel() })
  });

  res.status(upstream.status);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', upstream.headers.get('content-type') || (body.stream ? 'text/event-stream' : 'application/json'));

  if (!upstream.body) return res.end();
  return Readable.fromWeb(upstream.body).pipe(res);
}

async function callOpenAiCompatible(body, res, config) {
  const payload = {
    model: config.model,
    messages: toOpenAiMessages(body),
    max_tokens: body.max_tokens,
    stream: body.stream
  };

  if (process.env.AI_TEMPERATURE) payload.temperature = Number(process.env.AI_TEMPERATURE);
  if (body.effort && config.includeEffort) payload.effort = body.effort;
  if (body.effort && config.reasoningFormat === 'openrouter') {
    payload.reasoning = { effort: body.effort };
  }

  if (!payload.messages.length) return res.status(400).json({ error: 'Missing messages.' });

  const upstream = await fetch(chatCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (body.stream) return streamOpenAiAsAnthropic(upstream, res);

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return res.status(upstream.status).json(data);

  const text = (data.choices || []).map((choice) => {
    return choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
  }).join('');

  return res.json({ content: [{ type: 'text', text }] });
}

async function callYunwu(body, res) {
  const apiKey = process.env.YUNWU_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'YUNWU_API_KEY is not set on the server.' });
  }
  return callOpenAiCompatible(body, res, {
    apiKey,
    baseUrl: process.env.YUNWU_BASE_URL || 'https://yunwu.ai/v1',
    model: yunwuModel(body.modelTier),
    includeEffort: true,
    reasoningFormat: process.env.YUNWU_REASONING_FORMAT
  });
}

async function callMeta(body, res) {
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'META_API_KEY is not set on the server.' });
  }
  return callOpenAiCompatible(body, res, {
    apiKey,
    baseUrl: process.env.META_BASE_URL || 'https://api.meta.ai/v1',
    model: metaModel(),
    includeEffort: false
  });
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/ai/status', (req, res) => {
  const provider = ['yunwu', 'meta'].includes(aiProvider) ? aiProvider : 'anthropic';
  const model = provider === 'yunwu' ? yunwuModel('default') : (provider === 'meta' ? metaModel() : anthropicModel());
  const configured = provider === 'yunwu'
    ? Boolean(process.env.YUNWU_API_KEY || process.env.OPENAI_API_KEY)
    : (provider === 'meta' ? Boolean(process.env.META_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY));
  res.json({
    ok: true,
    provider,
    model,
    models: provider === 'yunwu'
      ? { default: yunwuModel('default'), threeD: yunwuModel('3d') }
      : { default: model },
    configured,
    limits: {
      perIpPerHour: Number(process.env.AI_REQUESTS_PER_IP_PER_HOUR || process.env.AI_REQUESTS_PER_HOUR || 20),
      globalPerDay: Number(process.env.AI_REQUESTS_GLOBAL_PER_DAY || 120),
      maxTokens: Number(process.env.AI_MAX_TOKENS || 8000)
    }
  });
});

const analyticsEvents = new Set([
  'app_open', 'screen_view', 'game_play', 'game_interaction', 'game_swipe',
  'like', 'comment', 'share', 'remix_start', 'create_start', 'game_published', 'report'
]);
const reportReasons = new Set(['broken', 'unsafe', 'copyright', 'spam']);

app.post('/api/events', async (req, res, next) => {
  try {
    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
    const accepted = events.filter((event) => event && analyticsEvents.has(event.name)).map((event) => ({
      name: event.name,
      gameId: String(event.gameId || '').replace(/[^\w-]/g, '').slice(0, 80),
      viewerHash: body.viewerId ? sha256Hex(String(body.viewerId).slice(0, 160)).slice(0, 24) : null,
      sessionId: String(body.sessionId || '').replace(/[^\w-]/g, '').slice(0, 64),
      source: String(body.source || '').replace(/[^\w-]/g, '').slice(0, 40),
      createdAt: Date.now()
    }));
    await writeStore((store) => {
      if (!Array.isArray(store.analytics)) store.analytics = [];
      store.analytics = store.analytics.concat(accepted).slice(-5000);
    });
    return res.json({ ok: true, accepted: accepted.length });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/reports', async (req, res, next) => {
  try {
    const body = req.body || {};
    const targetId = String(body.targetId || '').replace(/[^\w-]/g, '').slice(0, 80);
    const reason = String(body.reason || '');
    if (body.targetType !== 'game' || !targetId || !reportReasons.has(reason)) return res.status(400).json({ error: 'Invalid report.' });
    const store = await readStore();
    if (!Object.prototype.hasOwnProperty.call(store.shared, `ra-meta-${targetId}`)) return res.status(404).json({ error: 'Game not found.' });
    const reporterHash = body.viewerId ? sha256Hex(String(body.viewerId).slice(0, 160)).slice(0, 24) : null;
    await writeStore((current) => {
      if (!Array.isArray(current.reports)) current.reports = [];
      const duplicate = current.reports.some((report) => report.targetId === targetId && report.reporterHash === reporterHash && report.reason === reason);
      if (!duplicate) current.reports.push({ targetType: 'game', targetId, reporterHash, reason, status: 'open', createdAt: Date.now() });
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/storage', async (req, res, next) => {
  try {
    const store = await readStore();
    const { key, prefix } = req.query;

    if (typeof key === 'string') {
      if (!isValidKey(key)) return res.status(400).json({ error: 'Invalid key.' });
      return res.json({ value: Object.prototype.hasOwnProperty.call(store.shared, key) ? store.shared[key] : null });
    }

    if (typeof prefix === 'string') {
      if (prefix.length > 220) return res.status(400).json({ error: 'Invalid prefix.' });
      const keys = Object.keys(store.shared).filter((storedKey) => storedKey.startsWith(prefix));
      return res.json({ keys });
    }

    return res.status(400).json({ error: 'Pass either key or prefix.' });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/storage', async (req, res, next) => {
  try {
    const { key, value } = req.body || {};
    if (!isValidKey(key)) return res.status(400).json({ error: 'Invalid key.' });
    if (value !== null && typeof value !== 'string') return res.status(400).json({ error: 'Value must be a string or null.' });
    if (value !== null && jsonSize(value) > maxStoredValueBytes) return res.status(413).json({ error: 'Stored value is too large.' });

    if (PROTECTED_KEY.test(key)) {
      const token = String(req.get('x-ra-token') || '').slice(0, 128);
      const tokenHash = token ? sha256Hex(token) : null;
      const store = await readStore();
      const exists = Object.prototype.hasOwnProperty.call(store.shared, key);
      const owner = store.owners[key] || null;
      const isOwner = Boolean(owner && tokenHash && owner === tokenHash);

      if (value === null) {
        if (!exists) return res.json({ ok: true });
        if (!isOwner) return res.status(403).json({ error: 'Only the creator can delete this.' });
      } else if (exists && !isOwner) {
        if (key.startsWith('ra-code-')) return res.status(403).json({ error: 'Only the creator can change this game.' });
        if (!isEngagementOnlyChange(store.shared[key], value)) return res.status(403).json({ error: 'Only the creator can change this game.' });
      }

      await writeStore((s) => {
        if (value === null) {
          delete s.shared[key];
          delete s.owners[key];
        } else {
          if (!Object.prototype.hasOwnProperty.call(s.shared, key) && tokenHash) s.owners[key] = tokenHash;
          s.shared[key] = value;
        }
      });
      return res.json({ ok: true });
    }

    await writeStore((store) => {
      if (value === null) delete store.shared[key];
      else store.shared[key] = value;
    });

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/anthropic/messages', checkAiLimit, async (req, res, next) => {
  try {
    const body = cleanAiRequest(req.body || {});
    if (!body.messages.length) return res.status(400).json({ error: 'Missing messages.' });
    if (aiProvider === 'yunwu') return callYunwu(body, res);
    if (aiProvider === 'meta') return callMeta(body, res);
    return callAnthropic(body, res);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/images/cover', checkAiLimit, async (req, res, next) => {
  try {
    const title = String((req.body || {}).title || '').slice(0, 120);
    const concept = String((req.body || {}).prompt || '').slice(0, 600);
    if (!title && !concept) return res.status(400).json({ error: 'Missing prompt.' });
    const apiKey = process.env.YUNWU_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'YUNWU_API_KEY is not set on the server.' });
    const base = String(process.env.YUNWU_BASE_URL || 'https://yunwu.ai/v1').replace(/\/+$/, '');
    const payload = {
      model: process.env.YUNWU_IMAGE_MODEL || 'gpt-image-2',
      prompt: `Irresistible mobile game cover art in the style of a top-grossing app store hit, for a game titled "${title}". Scene: ${concept}. One charismatic hero subject filling most of the frame, facing the viewer with energy and personality, mid-action pose. Exaggerated depth and perspective, dramatic cinematic rim lighting, glossy vibrant saturated colors with strong complementary contrast, detailed stylized 3D-render look with soft painterly background bokeh. The composition must read instantly as a tiny thumbnail and make players want to tap it. Absolutely no text, letters, numbers, words, UI, watermarks, or logos anywhere. Kid-safe, general audience.`,
      size: process.env.YUNWU_IMAGE_SIZE || '1024x1024',
      n: 1,
    };
    if (process.env.YUNWU_IMAGE_QUALITY) payload.quality = process.env.YUNWU_IMAGE_QUALITY;
    const upstream = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    const raw = await upstream.text();
    if (!upstream.ok) return res.status(upstream.status >= 500 ? 502 : upstream.status).json({ error: `Image provider error ${upstream.status}: ${raw.slice(0, 300)}` });
    let data;
    try { data = JSON.parse(raw); } catch { return res.status(502).json({ error: 'Image provider returned unreadable data.' }); }
    const first = (data.data || [])[0] || {};
    if (first.b64_json) return res.json({ image: `data:image/png;base64,${first.b64_json}` });
    if (first.url) {
      const imageResp = await fetch(first.url);
      if (!imageResp.ok) return res.status(502).json({ error: 'The generated image could not be downloaded.' });
      const mime = (imageResp.headers.get('content-type') || 'image/png').split(';')[0];
      const buffer = Buffer.from(await imageResp.arrayBuffer());
      return res.json({ image: `data:${mime};base64,${buffer.toString('base64')}` });
    }
    return res.status(502).json({ error: 'Image provider returned no image.' });
  } catch (error) {
    return next(error);
  }
});

app.use(express.static(publicDir, {
  extensions: ['html'],
  setHeaders(res) {
    res.setHeader('cache-control', 'no-store');
  }
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  const status = Number(error.status || error.statusCode || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const message = safeStatus < 500 && error.expose ? error.message : 'Server error.';
  return res.status(safeStatus).json({ error: message });
});

app.listen(port, host, () => {
  console.log(`Remix Arcade running at http://localhost:${port}`);
  console.log(`Phone testing enabled on ${host}:${port}`);
});
