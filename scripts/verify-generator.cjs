const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const generatorStart = source.indexOf("var SHELL_TOP");
const generatorEnd = source.indexOf("var SEED_DODGE_HTML");

assert(generatorStart >= 0 && generatorEnd > generatorStart, "Generator source was not found.");

const generatorSource = source.slice(generatorStart, generatorEnd);
const context = {};
vm.createContext(context);
vm.runInContext(generatorSource, context);

const qualityStart = source.indexOf("function qualityError");
const qualityEnd = source.indexOf("var pendingCode", qualityStart);
assert(qualityStart >= 0 && qualityEnd > qualityStart, "Quality-gate source was not found.");
vm.runInContext(source.slice(qualityStart, qualityEnd), context);

const sample2D = [
  "var pulse=0;",
  "function resetGame(){hideScore();pulse=0;}",
  "function update(dt){pulse+=dt;}",
  "function draw(){ctx.fillStyle=String(123);ctx.fillRect(0,0,W,H);}",
].join("\n");

const sample3D = [
  "var cube;",
  "function resetGame(){hideScore();cube=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial());world.add(cube);}",
  "function update(dt){cube.rotation.y+=0.01*dt;}",
].join("\n");

const games = {
  "/2d": context.assembleGame(sample2D),
  "/3d": context.assembleGame3D(sample3D),
};

function inlineScripts(html) {
  const pattern = new RegExp("<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>", "g");
  return [...html.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

for (const [name, html] of Object.entries(games)) {
  const scripts = inlineScripts(html);
  assert(scripts.length > 0, `${name} has no executable game script.`);
  scripts.forEach((script) => new Function(script));
  assert(html.includes("ra-ready"), `${name} cannot report a successful startup.`);
  assert(html.includes("ra-crash"), `${name} cannot report a startup crash.`);
  assert(html.includes("scoreVisible"), `${name} does not support an optional score HUD.`);
}

assert(context.wants3D("a Doomlike maze shooter"), "Doomlike prompts should select 3D.");
assert(!context.wants3D("a cozy 2D pet"), "Explicit 2D prompts should remain 2D.");
assert.strictEqual(context.validateEngineCode(sample2D, false), null, "Valid 2D logic was rejected.");
assert.strictEqual(context.validateEngineCode(sample3D, true), null, "Valid 3D logic was rejected.");
const padding = `/*${"x".repeat(140)}*/`;
assert(/missing draw/.test(context.validateEngineCode(`function resetGame(){} function update(){} ${padding}`, false)), "Incomplete 2D logic was accepted.");
assert(/syntax error/.test(context.validateEngineCode(`function resetGame(){ function update(){} ${padding}`, true)), "Invalid JavaScript was accepted.");
assert(/GENRE FIDELITY/.test(generatorSource), "Genre-fidelity instructions are missing.");
assert(!/One clear arcade mechanic/.test(generatorSource), "A forced arcade rule remains in the generator.");
assert(source.includes("function validateEngineCode"), "The generated-code quality gate is missing.");
assert(source.includes("function preflightGeneratedGame"), "The generated-game startup check is missing.");

if (process.argv.includes("--serve")) {
  const port = Number(process.env.GENERATOR_TEST_PORT || 3011);
  http.createServer((request, response) => {
    const html = games[new URL(request.url, `http://localhost:${port}`).pathname];
    response.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(html || "Not found");
  }).listen(port, "127.0.0.1", () => {
    console.log(`Generator fixtures running at http://127.0.0.1:${port}`);
  });
} else {
  console.log("Generator verification passed for adaptive 2D and 3D shells.");
}
