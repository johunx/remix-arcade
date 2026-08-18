import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

interface Env {
  YUNWU_API_KEY?: string;
  OPENAI_API_KEY?: string;
  YUNWU_BASE_URL?: string;
  YUNWU_MODEL?: string;
  YUNWU_3D_MODEL?: string;
  AI_EFFORT?: string;
}

interface GenerationParams {
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens: number;
  modelTier: "3d" | "default";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part.text === "string" ? part.text : "").join("");
}

function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

async function generate(params: GenerationParams, env: Env): Promise<{ code: string; stopReason: string }> {
  const apiKey = env.YUNWU_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("YUNWU_API_KEY is not configured.");
  const messages = params.messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: textFromContent(message.content).slice(0, 120_000),
  })).filter((message) => message.content);
  if (params.system) messages.unshift({ role: "system", content: params.system.slice(0, 80_000) });

  /* a hung provider stream must die fast so the workflow retries in seconds
     instead of burning the whole step timeout */
  const controller = new AbortController();
  let lastActivity = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > 90_000) controller.abort();
  }, 5_000);

  try {
  const upstream = await fetch(completionsUrl(env.YUNWU_BASE_URL || "https://yunwu.ai/v1"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    signal: controller.signal,
    body: JSON.stringify({
      model: params.modelTier === "3d" ? (env.YUNWU_3D_MODEL || "claude-opus-5") : (env.YUNWU_MODEL || "claude-opus-5"),
      messages,
      max_tokens: params.maxTokens,
      stream: true,
      effort: env.AI_EFFORT || "high",
    }),
  });
  lastActivity = Date.now();
  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text()).slice(0, 500);
    const message = `AI provider error ${upstream.status}: ${detail}`;
    // 4xx (except rate limits) will fail identically on retry — don't burn paid attempts
    if (upstream.status >= 400 && upstream.status < 500 && upstream.status !== 429) throw new NonRetryableError(message);
    throw new Error(message);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let code = "";
  let stopReason = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    lastActivity = Date.now();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let event: any;
      try { event = JSON.parse(raw); } catch { continue; }
      if (event.error) {
        const message = String(event.error.message || event.error.code || "The AI provider stopped the request.");
        if (/content.?filter|moderation|policy|refus/i.test(message)) throw new NonRetryableError(message);
        throw new Error(message);
      }
      for (const choice of event.choices || []) {
        if (choice.finish_reason === "content_filter") throw new NonRetryableError("The AI provider stopped this prompt because of its content policy.");
        if (typeof choice.delta?.refusal === "string" && choice.delta.refusal) throw new NonRetryableError("The AI provider refused this prompt.");
        if (choice.finish_reason) stopReason = choice.finish_reason;
        if (choice.delta && typeof choice.delta.content === "string") code += choice.delta.content;
      }
    }
  }
  if (!code.trim()) throw new Error("The AI provider returned no game code.");
  return { code, stopReason };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The AI provider stopped responding mid-stream.");
    throw error;
  } finally {
    clearInterval(watchdog);
  }
}

export class GameGenerationWorkflow extends WorkflowEntrypoint<Env, GenerationParams> {
  async run(event: WorkflowEvent<GenerationParams>, step: WorkflowStep) {
    return step.do("generate-game", { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" }, timeout: "8 minutes" }, () => generate(event.payload, this.env));
  }
}
