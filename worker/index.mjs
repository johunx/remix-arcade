import seedStore from "../data/seed-storage.json";

const encoder = new TextEncoder();
let schemaReady = null;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function envNumber(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function isValidKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 220 && /^[a-zA-Z0-9:_./-]+$/.test(key);
}

async function ensureSchema(env) {
  if (!env.DB) throw new Error("Database binding is unavailable.");
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS storage (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_usage (
          bucket TEXT PRIMARY KEY NOT NULL,
          count INTEGER NOT NULL,
          reset_at INTEGER NOT NULL
        )`),
      ]);
      const metaCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM storage WHERE key LIKE 'ra-meta-%'").first();
      const seedEntries = Object.entries(seedStore.shared || {});
      if (Number(metaCount && metaCount.count) === 0 && seedEntries.length) {
        await env.DB.batch(seedEntries.map(([key, value]) => env.DB
          .prepare("INSERT INTO storage (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING")
          .bind(key, value, Date.now())));
      }
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function handleStorage(request, env) {
  await ensureSchema(env);
  const url = new URL(request.url);

  if (request.method === "GET") {
    const key = url.searchParams.get("key");
    const prefix = url.searchParams.get("prefix");
    if (key !== null) {
      if (!isValidKey(key)) return json({ error: "Invalid key." }, 400);
      const row = await env.DB.prepare("SELECT value FROM storage WHERE key = ?").bind(key).first();
      return json({ value: row ? row.value : null });
    }
    if (prefix !== null) {
      if (prefix.length > 220) return json({ error: "Invalid prefix." }, 400);
      const result = await env.DB.prepare("SELECT key FROM storage WHERE key LIKE ? ORDER BY key").bind(`${prefix}%`).all();
      return json({ keys: (result.results || []).map((row) => row.key) });
    }
    return json({ error: "Pass either key or prefix." }, 400);
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    const key = body && body.key;
    const value = body && body.value;
    if (!isValidKey(key)) return json({ error: "Invalid key." }, 400);
    if (value !== null && typeof value !== "string") return json({ error: "Value must be a string or null." }, 400);
    const maxBytes = envNumber(env, "MAX_STORED_VALUE_BYTES", 1_000_000);
    if (value !== null && encoder.encode(value).byteLength > maxBytes) {
      return json({ error: "Stored value is too large." }, 413);
    }
    if (value === null) {
      await env.DB.prepare("DELETE FROM storage WHERE key = ?").bind(key).run();
    } else {
      await env.DB.prepare(`INSERT INTO storage (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(key, value, Date.now()).run();
    }
    return json({ ok: true });
  }

  return json({ error: "Method not allowed." }, 405, { allow: "GET, POST" });
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part.text === "string" ? part.text : "").join("");
}

function getMaxTokens(body, env) {
  const requested = Number(body.max_tokens || 4096);
  const allowed = envNumber(env, "AI_MAX_TOKENS", 8000);
  return Math.max(1, Math.min(Number.isFinite(requested) ? requested : 4096, allowed));
}

function cleanAiRequest(body, env) {
  return {
    model: body.model,
    max_tokens: getMaxTokens(body, env),
    stream: Boolean(body.stream),
    system: typeof body.system === "string" ? body.system.slice(0, 80_000) : "",
    messages: Array.isArray(body.messages) ? body.messages.slice(0, 8) : [],
    effort: env.AI_EFFORT || env.CLAUDE_EFFORT || "",
  };
}

function toOpenAiMessages(body) {
  const messages = [];
  if (body.system) messages.push({ role: "system", content: body.system });
  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue;
    const content = textFromContent(message.content).slice(0, 120_000);
    if (content) messages.push({ role: message.role === "assistant" ? "assistant" : "user", content });
  }
  return messages;
}

function completionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "https://yunwu.ai/v1").replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

async function ipHash(request) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(ip));
  return Array.from(new Uint8Array(digest)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function incrementUsage(env, bucket, resetAt, now) {
  await env.DB.prepare(`INSERT INTO ai_usage (bucket, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      count = CASE WHEN ai_usage.reset_at <= ? THEN 1 ELSE ai_usage.count + 1 END,
      reset_at = CASE WHEN ai_usage.reset_at <= ? THEN excluded.reset_at ELSE ai_usage.reset_at END`)
    .bind(bucket, resetAt, now, now).run();
  return env.DB.prepare("SELECT count FROM ai_usage WHERE bucket = ?").bind(bucket).first();
}

async function checkAiLimit(request, env) {
  await ensureSchema(env);
  const now = Date.now();
  const perIpLimit = envNumber(env, "AI_REQUESTS_PER_IP_PER_HOUR", envNumber(env, "AI_REQUESTS_PER_HOUR", 20));
  const globalLimit = envNumber(env, "AI_REQUESTS_GLOBAL_PER_DAY", 120);
  const checks = [];

  if (perIpLimit > 0) {
    const hash = await ipHash(request);
    checks.push(incrementUsage(env, `ip:${hash}`, now + 60 * 60 * 1000, now).then((row) => ({
      exceeded: row && Number(row.count) > perIpLimit,
      message: "Too many AI requests. Please try again later.",
    })));
  }
  if (globalLimit > 0) {
    checks.push(incrementUsage(env, "global", now + 24 * 60 * 60 * 1000, now).then((row) => ({
      exceeded: row && Number(row.count) > globalLimit,
      message: "The beta AI budget is paused for today. Please try again tomorrow.",
    })));
  }

  const results = await Promise.all(checks);
  return results.find((result) => result.exceeded) || null;
}

function copyUpstream(upstream) {
  const headers = new Headers(upstream.headers);
  headers.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers });
}

function streamOpenAiAsAnthropic(upstream) {
  if (!upstream.ok || !upstream.body) return copyUpstream(upstream);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let event;
            try { event = JSON.parse(raw); } catch { continue; }
            const text = (event.choices || []).map((choice) => choice && choice.delta && typeof choice.delta.content === "string" ? choice.delta.content : "").join("");
            if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`));
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      reader.cancel();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

async function callOpenAiCompatible(body, env, config) {
  const payload = {
    model: config.model,
    messages: toOpenAiMessages(body),
    max_tokens: body.max_tokens,
    stream: body.stream,
  };
  if (!payload.messages.length) return json({ error: "Missing messages." }, 400);
  if (env.AI_TEMPERATURE) payload.temperature = Number(env.AI_TEMPERATURE);
  if (body.effort && config.includeEffort) payload.effort = body.effort;
  if (body.effort && config.reasoningFormat === "openrouter") payload.reasoning = { effort: body.effort };

  const upstream = await fetch(completionsUrl(config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(payload),
  });
  if (body.stream) return streamOpenAiAsAnthropic(upstream);

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return json(data, upstream.status);
  const text = (data.choices || []).map((choice) => choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : "").join("");
  return json({ content: [{ type: "text", text }] });
}

async function callAnthropic(body, env) {
  const apiKey = env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY;
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not set on the server." }, 500);
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": env.ANTHROPIC_VERSION || "2023-06-01",
    },
    body: JSON.stringify({ ...body, model: env.ANTHROPIC_MODEL || env.AI_MODEL || "claude-sonnet-5" }),
  });
  return copyUpstream(upstream);
}

async function handleAi(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST" });
  const limited = await checkAiLimit(request, env);
  if (limited) return json({ error: limited.message }, 429);

  const raw = await request.json().catch(() => null);
  if (!raw) return json({ error: "Invalid JSON." }, 400);
  const body = cleanAiRequest(raw, env);
  if (!body.messages.length) return json({ error: "Missing messages." }, 400);
  const provider = String(env.AI_PROVIDER || (env.YUNWU_API_KEY ? "yunwu" : "anthropic")).toLowerCase();

  if (provider === "yunwu") {
    const apiKey = env.YUNWU_API_KEY || env.OPENAI_API_KEY;
    if (!apiKey) return json({ error: "YUNWU_API_KEY is not set on the server." }, 500);
    return callOpenAiCompatible(body, env, {
      apiKey,
      baseUrl: env.YUNWU_BASE_URL || "https://yunwu.ai/v1",
      model: env.YUNWU_MODEL || env.AI_MODEL || "gpt-4o-mini",
      includeEffort: true,
      reasoningFormat: env.YUNWU_REASONING_FORMAT,
    });
  }
  if (provider === "meta") {
    if (!env.META_API_KEY) return json({ error: "META_API_KEY is not set on the server." }, 500);
    return callOpenAiCompatible(body, env, {
      apiKey: env.META_API_KEY,
      baseUrl: env.META_BASE_URL || "https://api.meta.ai/v1",
      model: env.META_MODEL || env.AI_MODEL || "muse-spark-1.1",
      includeEffort: false,
    });
  }
  return callAnthropic(body, env);
}

function aiStatus(env) {
  const provider = ["yunwu", "meta"].includes(String(env.AI_PROVIDER || "").toLowerCase()) ? String(env.AI_PROVIDER).toLowerCase() : "anthropic";
  const model = provider === "yunwu"
    ? (env.YUNWU_MODEL || env.AI_MODEL || "gpt-4o-mini")
    : provider === "meta"
      ? (env.META_MODEL || env.AI_MODEL || "muse-spark-1.1")
      : (env.ANTHROPIC_MODEL || env.AI_MODEL || "claude-sonnet-5");
  const configured = provider === "yunwu"
    ? Boolean(env.YUNWU_API_KEY || env.OPENAI_API_KEY)
    : provider === "meta"
      ? Boolean(env.META_API_KEY)
      : Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY);
  return json({
    ok: true,
    provider,
    model,
    configured,
    limits: {
      perIpPerHour: envNumber(env, "AI_REQUESTS_PER_IP_PER_HOUR", envNumber(env, "AI_REQUESTS_PER_HOUR", 20)),
      globalPerDay: envNumber(env, "AI_REQUESTS_GLOBAL_PER_DAY", 120),
      maxTokens: envNumber(env, "AI_MAX_TOKENS", 8000),
    },
  });
}

export const apiWorker = {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return json({ ok: true });
      if (url.pathname === "/api/ai/status") return aiStatus(env);
      if (url.pathname === "/api/storage") return handleStorage(request, env);
      if (url.pathname === "/api/anthropic/messages") return handleAi(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "Server error." }, 500);
    }
  },
};
