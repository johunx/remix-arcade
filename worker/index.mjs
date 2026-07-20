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

/* game content keys are ownership-protected: the browser token that creates a
   key becomes its owner (stored as a SHA-256 hash, never raw). */
const PROTECTED_KEY = /^ra-(meta|code)-/;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* non-owners may only change engagement data on a meta (plays, recentPlays,
   likedBy, cover-once) — identity fields must survive the write unchanged. */
function isEngagementOnlyChange(oldStr, newStr) {
  let a;
  let b;
  try {
    a = JSON.parse(oldStr);
    b = JSON.parse(newStr);
  } catch {
    return false;
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
  const frozen = ["id", "title", "prompt", "desc", "parentId", "creator", "createdAt"];
  for (const field of frozen) {
    const oldValue = a[field] === undefined ? null : a[field];
    const newValue = b[field] === undefined ? null : b[field];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) return false;
  }
  if (a.cover && b.cover !== a.cover) return false;
  return true;
}

async function ensureSchema(env) {
  if (!env.DB) throw new Error("Database binding is unavailable.");
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS storage (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          owner TEXT
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_usage (
          bucket TEXT PRIMARY KEY NOT NULL,
          count INTEGER NOT NULL,
          reset_at INTEGER NOT NULL
        )`),
      ]);
      await env.DB.prepare("ALTER TABLE storage ADD COLUMN owner TEXT").run().catch(() => {});
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
      const result = await env.DB.prepare("SELECT value FROM storage WHERE key = ?").bind(key).all();
      const row = (result.results || [])[0];
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
    const body = await request.text().then((text) => JSON.parse(text)).catch(() => null);
    const key = body && body.key;
    const value = body && body.value;
    if (!isValidKey(key)) return json({ error: "Invalid key." }, 400);
    if (value !== null && typeof value !== "string") return json({ error: "Value must be a string or null." }, 400);
    const maxBytes = envNumber(env, "MAX_STORED_VALUE_BYTES", 1_000_000);
    if (value !== null && encoder.encode(value).byteLength > maxBytes) {
      return json({ error: "Stored value is too large." }, 413);
    }
    if (!PROTECTED_KEY.test(key)) {
      if (value === null) {
        await env.DB.prepare("DELETE FROM storage WHERE key = ?").bind(key).run();
      } else {
        await env.DB.prepare("INSERT OR REPLACE INTO storage (key, value, updated_at) VALUES (?, ?, ?)")
          .bind(key, value, Date.now()).run();
      }
      return json({ ok: true });
    }

    const token = String(request.headers.get("x-ra-token") || "").slice(0, 128);
    const tokenHash = token ? await sha256Hex(token) : null;
    const existing = await env.DB.prepare("SELECT value, owner FROM storage WHERE key = ?").bind(key).first();
    const isOwner = Boolean(existing && existing.owner && tokenHash && existing.owner === tokenHash);

    if (value === null) {
      if (!existing) return json({ ok: true });
      if (!isOwner) return json({ error: "Only the creator can delete this." }, 403);
      await env.DB.prepare("DELETE FROM storage WHERE key = ?").bind(key).run();
      return json({ ok: true });
    }

    if (!existing) {
      await env.DB.prepare("INSERT OR REPLACE INTO storage (key, value, updated_at, owner) VALUES (?, ?, ?, ?)")
        .bind(key, value, Date.now(), tokenHash).run();
      return json({ ok: true });
    }

    if (!isOwner) {
      if (key.startsWith("ra-code-")) return json({ error: "Only the creator can change this game." }, 403);
      if (!isEngagementOnlyChange(existing.value, value)) return json({ error: "Only the creator can change this game." }, 403);
    }
    await env.DB.prepare("UPDATE storage SET value = ?, updated_at = ? WHERE key = ?").bind(value, Date.now(), key).run();
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
    modelTier: body.modelTier === "3d" ? "3d" : "default",
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
  const result = await env.DB.prepare("SELECT count, reset_at FROM ai_usage WHERE bucket = ?").bind(bucket).all();
  const current = (result.results || [])[0];
  const count = !current || Number(current.reset_at) <= now ? 1 : Number(current.count) + 1;
  const nextResetAt = !current || Number(current.reset_at) <= now ? resetAt : Number(current.reset_at);
  await env.DB.prepare("INSERT OR REPLACE INTO ai_usage (bucket, count, reset_at) VALUES (?, ?, ?)")
    .bind(bucket, count, nextResetAt).run();
  return { count };
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
        let pendingRead = reader.read();
        while (true) {
          const next = await Promise.race([
            pendingRead.then((result) => ({ result })),
            new Promise((resolve) => setTimeout(() => resolve({ heartbeat: true }), 10_000)),
          ]);
          if (next.heartbeat) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            continue;
          }
          const { value, done } = next.result;
          if (done) break;
          pendingRead = reader.read();
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
            if (event.error) {
              const message = typeof event.error === "string" ? event.error : (event.error.message || event.error.code || "The AI provider stopped the request.");
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: { code: "provider_error", message } })}\n\n`));
              continue;
            }
            const choices = event.choices || [];
            const refusal = choices.map((choice) => choice && choice.delta && typeof choice.delta.refusal === "string" ? choice.delta.refusal : "").join("");
            if (refusal) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: { code: "provider_refusal", message: "The AI provider refused this prompt." } })}\n\n`));
              continue;
            }
            const finishReason = choices.map((choice) => choice && choice.finish_reason).find(Boolean);
            if (finishReason === "content_filter") {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: { code: "content_filter", message: "The AI provider stopped this prompt because of its content policy." } })}\n\n`));
              continue;
            }
            if (finishReason) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: finishReason } })}\n\n`));
            const text = choices.map((choice) => choice && choice.delta && typeof choice.delta.content === "string" ? choice.delta.content : "").join("");
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

  const raw = await request.text().then((text) => JSON.parse(text)).catch(() => null);
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
      model: body.modelTier === "3d"
        ? (env.YUNWU_3D_MODEL || "gpt-5.6-sol")
        : (env.YUNWU_MODEL || env.AI_MODEL || "gpt-4o-mini"),
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

async function handleGenerationJobs(request, env) {
  if (!env.GAME_GENERATION_WORKFLOW) return json({ error: "Background generation is unavailable." }, 503);
  const url = new URL(request.url);
  if (request.method === "POST") {
    const limited = await checkAiLimit(request, env);
    if (limited) return json({ error: limited.message }, 429);
    const raw = await request.text().then((text) => JSON.parse(text)).catch(() => null);
    if (!raw) return json({ error: "Invalid JSON." }, 400);
    const body = cleanAiRequest(raw, env);
    if (!body.messages.length) return json({ error: "Missing messages." }, 400);
    const id = crypto.randomUUID();
    await env.GAME_GENERATION_WORKFLOW.create({
      id,
      params: {
        system: body.system,
        messages: body.messages,
        maxTokens: body.max_tokens,
        modelTier: body.modelTier,
      },
    });
    return json({ id, status: "queued" }, 202);
  }
  if (request.method === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!/^[a-f0-9-]{36}$/i.test(id)) return json({ error: "Invalid job ID." }, 400);
    const instance = await env.GAME_GENERATION_WORKFLOW.get(id);
    const status = await instance.status();
    return json({ id, ...status });
  }
  return json({ error: "Method not allowed." }, 405, { allow: "GET, POST" });
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
    models: provider === "yunwu" ? {
      default: env.YUNWU_MODEL || env.AI_MODEL || "gpt-4o-mini",
      threeD: env.YUNWU_3D_MODEL || "gpt-5.6-sol",
    } : { default: model },
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
      if (url.pathname === "/api/storage") return await handleStorage(request, env);
      if (url.pathname === "/api/generation/jobs") return await handleGenerationJobs(request, env);
      if (url.pathname === "/api/anthropic/messages") return await handleAi(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "Server error." }, 500);
    }
  },
};
