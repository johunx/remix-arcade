const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const workerSource = fs.readFileSync(path.join(__dirname, "..", "worker", "index.mjs"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
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

const errorStart = source.indexOf("function generationError");
const errorEnd = source.indexOf("function streamGame", errorStart);
assert(errorStart >= 0 && errorEnd > errorStart, "Generation-error mapping source was not found.");
vm.runInContext(source.slice(errorStart, errorEnd), context);

const sample2D = [
  "var pulse=0;",
  "function resetGame(){hideScore();pulse=0;}",
  "function update(dt){pulse+=dt;}",
  "function draw(){ctx.fillStyle=String(123);ctx.fillRect(0,0,W,H);}",
].join("\n");

const sample3D = [
  "var cube,shots;",
  "function resetGame(){enableFPSControls();setHud('HEALTH 100 | FIND THE EXIT');shots=0;cube=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial());world.add(cube);}",
  "function update(dt){cube.rotation.y+=0.01*dt;if(actions.firePressed)shots++;if(actions.abilityPressed)cube.scale.setScalar(1.2);}",
].join("\n");

const sampleDriving = [
  "var car,speed;",
  "function resetGame(){enableDrivingControls();speed=0;car=new THREE.Mesh(new THREE.BoxGeometry(2,1,4),new THREE.MeshBasicMaterial());world.add(car);}",
  "function update(dt){speed+=drive.throttle*dt;if(drive.brake)speed-=dt;car.rotation.y+=drive.steer*0.02*dt;car.position.z+=speed*0.02*dt;}",
].join("\n");

const games = {
  "/2d": context.assembleGame(sample2D),
  "/3d": context.assembleGame3D(sample3D),
};

function validationFixture(html) {
  const validationHtml = context.validationGameHtml(html);
  const serializedHtml = JSON.stringify(validationHtml).replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body><main id="result">waiting</main><script>
  var frame=document.createElement('iframe');
  frame.setAttribute('sandbox','allow-scripts');
  frame.style.cssText='position:fixed;left:0;top:0;width:390px;height:700px;opacity:.001;pointer-events:none;border:0;transform:scale(.001);transform-origin:0 0;z-index:0;';
  addEventListener('message',function(event){if(event.source===frame.contentWindow&&event.data&&event.data.type==='ra-ready'){document.getElementById('result').textContent='ready';frame.remove();}});
  document.body.appendChild(frame);
  setTimeout(function(){if(document.getElementById('result').textContent!=='ready')document.getElementById('result').textContent='timeout';},7000);
  frame.srcdoc=${serializedHtml};
  <\/script></body>`;
}

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

games["/validate-2d"] = validationFixture(games["/2d"]);
games["/validate-3d"] = validationFixture(games["/3d"]);

assert(context.wants3D("a Doomlike maze shooter"), "Doomlike prompts should select 3D.");
assert(context.wants3D("a GTA-style free-roaming city"), "Strong open-world prompts should select 3D.");
assert(!context.wants3D("a cozy 2D pet"), "Explicit 2D prompts should remain 2D.");
assert(!context.wants3D("a 2D open-world driving game"), "Explicit 2D intent should override genre inference.");
assert(context.requiresFPSControls("a 3D portal shooter", true), "3D shooters should require full FPS controls.");
assert(!context.requiresFPSControls("a 3D third-person shooter", true), "Third-person games should not be forced into FPS controls.");
assert(context.requiresDrivingControls("a 3D car driving game", true), "Car games should require driving controls.");
assert(!context.requiresDrivingControls("a 2D car game", false), "2D games should not require the 3D driving controls.");
assert.strictEqual(context.validateEngineCode(sample2D, false), null, "Valid 2D logic was rejected.");
assert.strictEqual(context.validateEngineCode(sample3D, true), null, "Valid 3D logic was rejected.");
assert.strictEqual(context.validateEngineCode(sample3D, true, true), null, "A complete FPS control setup was rejected.");
assert(/FIRE button/.test(context.validateEngineCode(sample3D.replace("actions.firePressed", "input.justTapped"), true, true)), "An FPS without a working FIRE button was accepted.");
assert.strictEqual(context.validateEngineCode(sampleDriving, true, false, true), null, "A complete driving control setup was rejected.");
assert(/visible steering/.test(context.validateEngineCode(sampleDriving.replace("enableDrivingControls();", ""), true, false, true)), "A car game without visible controls was accepted.");
const padding = `/*${"x".repeat(140)}*/`;
assert(/missing draw/.test(context.validateEngineCode(`function resetGame(){} function update(){} ${padding}`, false)), "Incomplete 2D logic was accepted.");
assert(/syntax error/.test(context.validateEngineCode(`function resetGame(){ function update(){} ${padding}`, true)), "Invalid JavaScript was accepted.");
assert(/GENRE FIDELITY/.test(generatorSource), "Genre-fidelity instructions are missing.");
assert(!/One clear arcade mechanic/.test(generatorSource), "A forced arcade rule remains in the generator.");
assert(generatorSource.includes("function enableFPSControls"), "The 3D engine does not provide complete FPS controls.");
assert(generatorSource.includes("function enableDrivingControls"), "The 3D engine does not provide driving controls.");
assert(generatorSource.includes('makeActionButton("GAS"'), "The 3D shell is missing its GAS button.");
assert(generatorSource.includes('makeActionButton("BRAKE"'), "The 3D shell is missing its BRAKE button.");
assert(games["/3d"].includes('makeActionButton("FIRE"'), "The 3D shell is missing its FIRE button.");
assert(games["/3d"].includes('makeActionButton("ABILITY"'), "The 3D shell is missing its ABILITY button.");
assert(games["/3d"].includes("actions.firePressed=false"), "FPS action presses are not reset each frame.");
assert(games["/3d"].includes('if(!fpsControlsOn&&typeof onTap==="function")'), "Aim touches can still trigger FPS actions.");
assert(generatorSource.includes("Never use a generic screen tap or onTap as the primary FPS fire control"), "The 3D prompt still permits ambiguous tap-to-fire controls.");
assert(generatorSource.includes("Do not default to an arcade structure"), "The 3D prompt still defaults to arcade structure.");
assert(generatorSource.includes("A sandbox or open-world shooter may intentionally have no mission"), "Open-world games are still forced into mission structure.");
assert(source.includes("function validateEngineCode"), "The generated-code quality gate is missing.");
assert(source.includes("function preflightGeneratedGame"), "The generated-game startup check is missing.");
assert(context.validationGameHtml(games["/2d"]).includes("window.requestAnimationFrame"), "The mobile validation clock is missing.");
assert(!source.includes("left:-10000px"), "The validation frame is still placed far outside the mobile viewport.");
assert(source.includes("Check again — free"), "The free validation retry is not labelled clearly.");
assert(source.includes("Publish anyway — free"), "Timeout-only builds cannot be published without another AI call.");
assert(source.includes("Retry with AI"), "Paid AI retries are not labelled clearly.");
assert(source.includes("function mappedGenerationError"), "Generation errors are not mapped to useful messages.");
assert(source.includes("job.retryWithoutGeneration"), "Generated code is not retained for a free validation retry.");
assert(source.includes("Publishing without another AI call"), "The free validation retry can still trigger an unlabeled AI call.");
assert(workerSource.includes('code: "provider_refusal"'), "The deployed worker does not relay provider refusals.");
assert(workerSource.includes('finishReason === "content_filter"'), "The deployed worker does not relay content filtering.");
assert(workerSource.includes('body.modelTier === "3d"'), "The worker does not allowlist 3D model routing.");
assert(workerSource.includes('env.YUNWU_3D_MODEL || "gpt-5.6-sol"'), "The worker does not route 3D games to Sol.");
assert(serverSource.includes("code: 'provider_refusal'"), "The local server does not relay provider refusals.");
assert(serverSource.includes("process.env.YUNWU_3D_MODEL || 'gpt-5.6-sol'"), "The local server does not mirror Sol routing.");
assert(source.includes("modelTier:modelTier==='3d'?'3d':'default'"), "The client does not label 3D generation requests.");
assert.strictEqual(context.mappedGenerationError(429, '{"error":"Too many AI requests"}').retryKind, "wait", "Hourly limits should not offer a paid retry.");
assert.strictEqual(context.mappedGenerationError(400, '{"error":"content_filter"}').code, "provider_policy", "Content-policy failures are not identified.");
assert.strictEqual(context.mappedGenerationError(402, '{"error":"insufficient balance"}').code, "provider_credit", "Provider credit failures are not identified.");

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
