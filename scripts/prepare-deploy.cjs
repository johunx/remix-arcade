const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "..", "dist", "server", "wrangler.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// The Vite adapter still emits this retired Wrangler setting.
delete config.legacy_env;

fs.writeFileSync(configPath, JSON.stringify(config));
console.log("Cloudflare deployment config is ready.");
