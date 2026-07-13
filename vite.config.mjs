import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin.mjs";

const placeholderDatabaseId = "00000000-0000-4000-8000-000000000000";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "server" },
      config: {
        name: "remix-arcade",
        main: "./worker/index.mjs",
        compatibility_date: "2026-05-22",
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
    sites(),
  ],
});
