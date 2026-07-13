import handler from "vinext/server/app-router-entry";
import { apiWorker } from "./index.mjs";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  [key: string]: unknown;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/healthz" || pathname.startsWith("/api/")) {
      return apiWorker.fetch(request, env);
    }
    return handler.fetch(request, env, ctx);
  },
};
