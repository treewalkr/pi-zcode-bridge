// Opt-in live integration check. Uses the signed-in account's Start Plan
// quota (two tiny turns) and validates the bridge end to end: catalog,
// auth, model selection, streaming and multi-turn continuity.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const directory = await mkdtemp(join(tmpdir(), "pi-zcode-bridge-smoke-"));
const extension =
  process.env.SMOKE_EXTENSION || fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const model = process.env.SMOKE_MODEL || "Start Plan/GLM-5.3-Flash";
const child = spawn(process.env.PI_BIN || "pi", [
  "--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension,
  "--provider", "zcode", "--model", model, "--no-tools",
  "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
], { cwd: directory, env: {
  ...process.env, ZCODE_V2_CONFIG: process.env.ZCODE_V2_CONFIG || join(homedir(), ".zcode/v2/config.json"),
  ZCODE_AUTO_ALLOW: "0",
}, stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout });
let stderrBytes = 0;
let count = 0;
let failed = false;
child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
const send = value => child.stdin.write(JSON.stringify(value) + "\n");
const timer = setTimeout(() => {
  failed = true;
  console.error("bridge smoke timed out");
  child.kill("SIGTERM");
}, 90000);
lines.on("line", line => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === "response" && event.command === "get_available_models") {
    console.log("Catalog:", event.data.models.filter(m => m.provider === "zcode").map(m => m.id));
  }
  if (event.type !== "message_end" || event.message?.role !== "assistant") return;
  const message = event.message;
  const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
  count += 1;
  console.log({ turn: count, model: message.model, stopReason: message.stopReason, text,
    error: message.errorMessage, usage: message.usage });
  if (message.stopReason !== "stop" || text !== `PI-BRIDGE-${count}-OK`) {
    failed = true;
    child.kill("SIGTERM");
  } else if (count === 1) {
    send({ type: "prompt", message: "Do not use tools. Reply exactly PI-BRIDGE-2-OK." });
  } else child.kill("SIGTERM");
});
child.on("error", error => { failed = true; console.error(error.message); });
const exited = new Promise(resolve => child.once("close", resolve));
send({ type: "get_available_models" });
send({ type: "prompt", message: "Do not use tools or access files. Reply exactly PI-BRIDGE-1-OK." });
await exited;
clearTimeout(timer);
lines.close();
await rm(directory, { recursive: true, force: true });
const passed = !failed && count === 2;
console.log(passed ? "PASS" : "FAIL", { stderrBytes });
process.exitCode = passed ? 0 : 1;
