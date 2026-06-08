// Manual executor smoke test (Task 12). Starts the bridge hub, waits for your
// executor bridge to connect, then calls each read tool for real and prints the
// round-trip result. Run: `node scripts/smoke.mjs` (after `npm run build`).
import { loadConfig } from "../dist/config.js";
import { BridgeHub } from "../dist/bridge-hub/ws-server.js";
import { getApiDump } from "../dist/api-dump/fetch.js";
import { Session } from "../dist/mcp/session.js";
import { allTools } from "../dist/mcp/server.js";

const config = loadConfig();
const hub = new BridgeHub(config);
const port = await hub.start();
const dump = await getApiDump();
const session = new Session(hub, config, dump);
const tools = Object.fromEntries(allTools(session).map((t) => [t.name, t]));

console.log(`\n[smoke] hub up on http://127.0.0.1:${port}  (API dump: ${dump ? "loaded" : "fallback"})`);
console.log(`[smoke] In your executor, run:\n  loadstring(game:HttpGet("http://127.0.0.1:${port}/bridge"))()\n`);
console.log(`[smoke] waiting for the bridge to connect (60s)...`);

const deadline = Date.now() + 60_000;
while (!hub.isConnected()) {
  if (Date.now() > deadline) {
    console.log(`[smoke] no bridge connected after 60s. Check the executor console for "[dex-bridge] connected".`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 300));
}
console.log(`[smoke] bridge connected — running tools.\n`);

async function call(name, args = {}) {
  const res = await tools[name].handler(args);
  const tag = res.isError ? "ERROR" : "ok";
  console.log(`──── ${name}(${JSON.stringify(args)})  [${tag}]`);
  console.log(res.content?.[0]?.text ?? JSON.stringify(res));
  console.log();
  return res.isError ? undefined : res.structuredContent;
}

const status = await call("dex_status");
console.log(`[smoke] game: ${status?.gameName}  placeId: ${status?.placeId}  caps: ${JSON.stringify(status?.capabilities)}\n`);

const root = await call("get_root");
const ws = root?.services?.find((s) => s.className === "Workspace") ?? root?.services?.[0];
if (ws) {
  const kids = await call("get_children", { ref: ws.ref });
  const firstPart = kids?.children?.find((c) => c.className === "Part") ?? kids?.children?.[0];
  if (firstPart) await call("get_properties", { ref: firstPart.ref }); // watch Vector3 + any EnumItem here
}
await call("search", { query: "Part" });
await call("get_by_path", { path: "game.Workspace" });

console.log(`[smoke] done. Ctrl+C to exit (the hub keeps the bridge alive until you do).`);
