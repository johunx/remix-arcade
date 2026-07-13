import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function sites() {
  let root = process.cwd();
  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const serverDirectory = resolve(root, "dist", "server");
      const moduleEntry = resolve(serverDirectory, "index.mjs");
      const expectedEntry = resolve(serverDirectory, "index.js");
      const outputDirectory = resolve(root, "dist", ".openai");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const drizzleSource = resolve(root, "drizzle");

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });
      if (await exists(moduleEntry)) {
        await cp(moduleEntry, expectedEntry);
      }
      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), { recursive: true });
      }
    },
  };
}
