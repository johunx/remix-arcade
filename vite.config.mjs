import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";
import { sites } from "./build/sites-vite-plugin.mjs";

const placeholderDatabaseId = "00000000-0000-4000-8000-000000000000";

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
        assets: {
          binding: "ASSETS",
          not_found_handling: "single-page-application",
          run_worker_first: ["/api/*", "/healthz"],
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "remix-arcade-db",
            database_id: placeholderDatabaseId,
          },
        ],
      },
    }),
  ],
});
