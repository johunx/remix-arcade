const express = require('express');
const fs = require('fs/promises');
const path = require('path');
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

function yunwuModel() {
  return process.env.YUNWU_MODEL || process.env.AI_MODEL || 'gpt-4o-mini';
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

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
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

      const text = (event.choices || []).map((choice) => {
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
    model: yunwuModel(),
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
  const model = provider === 'yunwu' ? yunwuModel() : (provider === 'meta' ? metaModel() : anthropicModel());
  const configured = provider === 'yunwu'
    ? Boolean(process.env.YUNWU_API_KEY || process.env.OPENAI_API_KEY)
    : (provider === 'meta' ? Boolean(process.env.META_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY));
  res.json({
    ok: true,
    provider,
    model,
    configured,
    limits: {
      perIpPerHour: Number(process.env.AI_REQUESTS_PER_IP_PER_HOUR || process.env.AI_REQUESTS_PER_HOUR || 20),
      globalPerDay: Number(process.env.AI_REQUESTS_GLOBAL_PER_DAY || 120),
      maxTokens: Number(process.env.AI_MAX_TOKENS || 8000)
    }
  });
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
