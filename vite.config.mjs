import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";
import { sites } from "./build/sites-vite-plugin.mjs";

const databaseId = "16c32f04-e33a-4f00-9653-f055636b0280";

export default defineConfig({
  plugins: [
    vinext(),
    sites(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      config: {
        name: "remix-arcade",
        main: "./worker/entry.ts",
        compatibility_date: "2026-05-22",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          AI_PROVIDER: "yunwu",
          YUNWU_BASE_URL: "https://yunwu.ai/v1",
          YUNWU_MODEL: "gpt-5.6-luna",
          AI_EFFORT: "high",
          AI_REQUESTS_PER_IP_PER_HOUR: "6",
          AI_REQUESTS_GLOBAL_PER_DAY: "80",
          AI_MAX_TOKENS: "8000",
          MAX_STORED_VALUE_BYTES: "1000000",
        },
        assets: {
          binding: "ASSETS",
          not_found_handling: "single-page-application",
          run_worker_first: ["/api/*", "/healthz"],
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "remix-arcade-db",
            database_id: databaseId,
          },
        ],
      },
    }),
  ],
});
