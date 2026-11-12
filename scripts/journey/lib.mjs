// What every journey shares: the server (built and started here, or one that is running),
// the REST and MCP calls an agent makes, the browser profiles, and the SAW/ASSUMED report.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, spawnSync, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import assert from "node:assert/strict";

const run = promisify(execFile);
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// A phone is touch with a 390x844 screen; a desktop is a mouse in 1280x800. `context` is
// what Playwright needs to make the browser behave like each.
export const PHONE = {
  name: "390x844",
  touch: true,
  context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
export const DESKTOP = { name: "1280x800", touch: false, context: { viewport: { width: 1280, height: 800 } } };

// ---- the server ----------------------------------------------------------------------
// --local builds the binary and starts it on a random port with a data directory of its
// own; --base uses a server that is already running.
export async function startLocal() {
  const dir = await mkdtemp(path.join(tmpdir(), "shartifacts-journey-"));
  const binary = path.join(dir, "shartifacts");
  // This machine has Go only through mise; elsewhere a plain go is on the PATH.
  const go = spawnSync("go", ["version"]).status === 0 ? ["go"] : ["mise", "x", "go@1.26", "--", "go"];
  const t0 = performance.now();
  const build = spawnSync(go[0], [...go.slice(1), "build", "-o", binary, "."], { cwd: repo, stdio: "inherit" });
  assert.equal(build.status, 0, "go build failed");
  const port = 18000 + Math.floor(Math.random() * 10000);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(binary, ["-listen", `127.0.0.1:${port}`, "-data", path.join(dir, "data")], { stdio: ["ignore", "ignore", "pipe"] });
  const stderr = [];
  proc.stderr.on("data", (b) => stderr.push(...String(b).split("\n").filter(Boolean)));
  // The server answers /healthz when it is ready; retry on the connection, not on a clock.
  for (let ok = false; !ok; ) {
    assert.equal(proc.exitCode, null, "the server exited:\n" + stderr.slice(-20).join("\n"));
    ok = await fetch(base + "/healthz").then((r) => r.ok, () => false);
  }
  return {
    base,
    dir,
    binary,
    built: Math.round(performance.now() - t0),
    stderr: () => stderr.slice(-20).join("\n"),
    rssKB: () => Number(spawnSync("ps", ["-o", "rss=", "-p", String(proc.pid)]).stdout) || 0,
    stop: () => new Promise((resolve) => (proc.exitCode !== null ? resolve() : (proc.once("exit", resolve), proc.kill("SIGTERM")))),
  };
}

export const sizeOf = async (file) => (await stat(file)).size;

// ---- what an agent calls -------------------------------------------------------------
export async function api(base, route, body, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  assert.ok(r.ok, `${method} ${route} answered ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// One MCP session, as an agent has: call(tool, args) returns the structured result.
export async function mcpSession(base) {
  const client = new Client({ name: "journey-agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  return {
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
      const text = r.content?.find((c) => c.type === "text")?.text;
      assert.ok(!r.isError, `${name} failed: ${text}`);
      return r.structuredContent ?? JSON.parse(text);
    },
    close: () => client.close(),
  };
}

// The agent's wake: take a cursor now, then start waiting for the next event of a kind on
// one artifact. `woken()` resolves when the server answers, with how long that took from
// the moment `mark()` was called (call it right before the action that should wake it).
export async function watch(base, id, kind) {
  const agent = await mcpSession(base);
  const { cursor } = await agent.call("watch_artifacts", { ids: [id], kinds: [kind], wait_seconds: 0 });
  let t0 = Date.now();
  const waiting = agent.call("watch_artifacts", { ids: [id], kinds: [kind], after: cursor, wait_seconds: 45 });
  // If the journey fails before it asks, the server may stop under this call; that is not a second failure.
  waiting.catch(() => {});
  return {
    mark: () => (t0 = Date.now()),
    async woken() {
      const r = await waiting;
      const ms = Date.now() - t0;
      await agent.close();
      assert.ok(r.events.some((e) => e.kind === kind), `no ${kind} event came: ${JSON.stringify(r)}`);
      return { ms, events: r.events };
    },
  };
}

// ---- the agent-side picture command (the dotfiles shx-note-image) ---------------------
export async function noteImage(args) {
  const cmd = process.env.SHX_NOTE_IMAGE || "shx-note-image";
  try {
    const { stdout } = await run(cmd, args, { maxBuffer: 1 << 24 });
    const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
    assert.ok(line, `${cmd} printed no JSON: ${stdout}`);
    return JSON.parse(line);
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`${cmd} was not found: set SHX_NOTE_IMAGE to the dotfiles shx-note-image command`);
    throw new Error(`${cmd} ${args.join(" ")} failed: ${e.stderr || e.message}`);
  }
}

// A PNG says its size in the first 24 bytes: the check that the agent got a real picture.
export async function pngSize(file) {
  const b = await readFile(file);
  assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

// ---- the report ----------------------------------------------------------------------
export class StepFailed extends Error {}

// A journey's voice: every step says what it SAW or what it only ASSUMED, with its time. A
// step that says neither failed to prove anything, so it fails. The first failed step stops
// its journey and leaves the evidence: the error, and a screenshot of every open page.
export function reporter(label, outDir) {
  const t0 = performance.now();
  const timings = [];
  const pages = new Set();
  const say = (line) => console.log(`[${label}] ${line}`);
  async function step(name, fn) {
    const s0 = performance.now();
    let said = 0;
    const at = () => `+${Math.round(performance.now() - s0)}ms`;
    const note = {
      saw: (m) => (said++, say(`SAW ${name}: ${m} (${at()})`)),
      assumed: (m) => (said++, say(`ASSUMED ${name}: ${m} (${at()})`)),
    };
    try {
      await fn(note);
      assert.ok(said, `step ${name} observed nothing`);
    } catch (e) {
      say(`FAIL ${name} (${at()}): ${e.message}`);
      if (e.stack) say(e.stack.split("\n").slice(1, 6).join("\n"));
      let n = 0;
      for (const page of pages)
        await page.screenshot({ path: path.join(outDir, `FAIL-${label.replace(/\W+/g, "-")}-${name.replace(/\W+/g, "-")}-${n++}.png`) }).then(() => say(`evidence: screenshot ${n} in ${outDir}`), () => {});
      throw new StepFailed(`${label} ${name}: ${e.message}`, { cause: e });
    } finally {
      timings.push([name, Math.round(performance.now() - s0)]);
    }
  }
  return {
    step,
    say,
    pages,
    track: (page) => (pages.add(page), page),
    shot: (page, name) => page.screenshot({ path: path.join(outDir, `${label.replace(/\W+/g, "-")}-${name}.png`) }),
    totalMs: () => Math.round(performance.now() - t0),
    timings: () => timings,
  };
}

export async function outputDir(arg) {
  const dir = arg ? path.resolve(arg) : await mkdtemp(path.join(tmpdir(), "journey-out-"));
  await mkdir(dir, { recursive: true });
  return dir;
}
