const fs = require("fs");
const path = require("path");
const vm = require("vm");

if (!process.argv.includes("--allow-paid")) {
  console.error("Refusing to call the live AI without --allow-paid.");
  process.exit(2);
}

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const generatorStart = source.indexOf("var SHELL_TOP");
const generatorEnd = source.indexOf("var SEED_DODGE_HTML");
const qualityStart = source.indexOf("function qualityError");
const qualityEnd = source.indexOf("var pendingCode", qualityStart);
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(generatorStart, generatorEnd), context);
vm.runInContext(source.slice(qualityStart, qualityEnd), context);

const cases = {
  sandbox: "Create a 3D first-person open-world cartoon sci-fi city sandbox. There is deliberately no mission, score, timer, win state, or forced game over. Let the player freely walk around, drive a simple hover vehicle, explore several recognizable places, interact with props, use a blaster, and trigger a portal-burst ability. Make the world playful rather than an arena or endless arcade survival game.",
  mission: "Create a 3D first-person portal-cartoon shooter with several connected rooms and landmarks. The player must defeat moving robot enemies, collect three energy crystals, and reach an exit portal. Include health, clear enemy attacks, firing feedback, a FIRE button, and a portal-blast ABILITY with a cooldown. Do not make an endless runner, stationary target gallery, or score-only arcade survival game.",
};

const requested = process.argv.filter((arg) => arg.startsWith("--case=")).map((arg) => arg.slice(7));
if (requested.length !== 1) {
  console.error("Choose exactly one paid evaluation with --case=sandbox or --case=mission.");
  process.exit(2);
}
const names = requested;
for (const name of names) {
  if (!cases[name]) throw new Error(`Unknown evaluation case: ${name}`);
}

const endpoint = (process.env.EVAL_BASE_URL || "https://remix-arcade.johunx.workers.dev") + "/api/anthropic/messages";
const outputDir = path.join(root, ".generation-evals");
fs.mkdirSync(outputDir, { recursive: true });

async function generate(name, prompt) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      stream: true,
      system: context.SYS_3D_JS,
      messages: [{ role: "user", content: `Create a game based on this idea: "${prompt}"` }],
    }),
    signal: AbortSignal.timeout(210000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${name} failed (${response.status}): ${raw.slice(0, 500)}`);

  let code = "";
  let stopReason = "";
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("data:")) continue;
    const payload = line.trim().slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try { event = JSON.parse(payload); } catch (_) { continue; }
    if (event.type === "message_delta" && event.delta?.stop_reason) stopReason = event.delta.stop_reason;
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") code += event.delta.text;
  }
  code = code.trim().replace(/^```(?:javascript|js)?\s*/i, "").replace(/```\s*$/, "").trim();
  const fpsRequired = context.requiresFPSControls(prompt, true);
  const issue = context.validateEngineCode(code, true, fpsRequired);
  const file = path.join(outputDir, `${name}.js`);
  fs.writeFileSync(file, code, "utf8");
  return {
    name,
    characters: code.length,
    stopReason,
    validation: issue || "passed",
    controls: {
      fps: /\benableFPSControls\s*\(/.test(code),
      fire: /\bactions\.fire(?:Pressed)?\b/.test(code),
      ability: /\bactions\.ability(?:Pressed)?\b/.test(code),
      hud: /\bsetHud\s*\(/.test(code),
    },
    structure: {
      gameOverCalls: (code.match(/\bgameOver\s*\(/g) || []).length,
      scoreCalls: (code.match(/\b(?:addScore|setScore|showScore)\s*\(/g) || []).length,
      meshes: (code.match(/new\s+THREE\.Mesh\s*\(/g) || []).length,
    },
    savedTo: path.relative(root, file),
  };
}

(async () => {
  const results = [];
  for (const name of names) results.push(await generate(name, cases[name]));
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
