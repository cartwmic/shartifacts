// The workspace side of the draw tool against a real server and a real preview: the Draw
// tool in the framed artifact, the composer showing the stroke, the comment sent with it,
// and the match report posted for the version shown. The overlay's geometry is covered
// without a server by draw-unit-test.mjs. Run with `node scripts/draw-workspace-test.mjs`.
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const started = Date.now();
const dir = await mkdtemp(path.join(tmpdir(), "shartifacts-draw-"));
const binary = path.join(dir, "shartifacts");
assert.equal(spawnSync("go", ["build", "-o", binary, "."], { stdio: "inherit" }).status, 0);
const port = 19400 + Math.floor(Math.random() * 500),
  base = `http://127.0.0.1:${port}`;
const server = spawn(binary, ["-listen", `127.0.0.1:${port}`, "-data", path.join(dir, "data")], { stdio: ["ignore", "ignore", "inherit"] });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base + "/healthz")).ok) break;
    } catch {}
    assert.ok(i < 100, "the server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
  const content = `<!doctype html><body style="margin:0;font:16px sans-serif"><h1 id="title">Report</h1><p id="note">Revenue grew.</p><div id="chart" style="margin:40px;height:200px;background:#cde;overflow:hidden">${"😀".repeat(130)}</div></body>`;
  const made = await (await fetch(base + "/api/artifacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Draw", kind: "html", content }) })).json();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/a/${made.id}`);
  await page.locator("#preview[data-ready=true]").waitFor();
  const frame = page.frameLocator("#preview");
  // What the frame says to the workspace, for a failure to be read by.
  await page.evaluate(() => {
    window.said = [];
    addEventListener("message", (e) => window.said.push(e.data?.type + (e.data?.results ? JSON.stringify(e.data.results) : "")));
  });

  await page.locator("#comment-mode").click();
  await frame.getByRole("button", { name: "Draw" }).click();
  const chart = await (await page.locator("#preview").elementHandle()).contentFrame().then((f) => f.evaluate(() => { const r = document.querySelector("#chart").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }));
  const frameBox = await page.locator("#preview").boundingBox();
  const cx = frameBox.x + chart.x + chart.w / 2,
    cy = frameBox.y + chart.y + chart.h / 2;
  await page.mouse.move(cx - 100, cy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(cx - 100 + i * 10, cy + Math.sin(i / 3) * 30);
  await page.mouse.up();
  await page.locator("#comment-popover:not([hidden])").waitFor();
  assert.equal(await page.locator("#pointed-label").textContent(), "Drawing on div#chart");
  await page.locator("#comment-popover .stroke-thumb path").waitFor();
  console.log("SAW the composer opens on release, labelled for the drawing and showing the stroke");

  // Undo in the frame closes the composer; drawing again opens it again.
  await frame.getByRole("button", { name: "Undo" }).click();
  await page.locator("#comment-popover").waitFor({ state: "hidden" });
  await page.mouse.move(cx - 100, cy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(cx - 100 + i * 10, cy + Math.sin(i / 3) * 30);
  await page.mouse.up();
  await page.locator("#comment-popover:not([hidden])").waitFor();
  console.log("SAW Undo in the frame closes the composer, and a new stroke opens it again");

  await page.locator("#comment-popover textarea").fill("Make this chart taller");
  // This test is about the workspace page, so the stroke is read off the request and the
  // comment goes on without it: whether a server stores a stroke is for its own tests and
  // for the journeys, and this one must not depend on it.
  let body;
  await page.route(`**/api/artifacts/${made.id}/comments`, (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    body = request.postDataJSON();
    const { stroke, ...rest } = body;
    route.continue({ postData: JSON.stringify(rest) });
  });
  const posted = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/artifacts/${made.id}/comments`));
  await page.locator("#comment-popover button.primary").click();
  await posted;
  assert.equal(body.anchor, "#chart");
  assert.equal(body.quote, undefined);
  assert.equal(body.stroke.v, 1);
  assert.equal(body.stroke.anchor, "#chart");
  assert.equal(typeof body.stroke.anchor_tag, "string", "the posted stroke says what its anchor was");
  // The anchor's first 120 characters, cut between characters (a cut inside an emoji would not survive the round trip).
  assert.equal(body.stroke.anchor_text, Array.from("😀".repeat(130)).slice(0, 120).join(""));
  assert.ok(body.stroke.points.length > 10 && body.stroke.elements.some((e) => e.path === "#chart"));
  assert.equal(body.version, 1);
  console.log(`SAW the comment posts with its stroke (${body.stroke.points.length} points, anchor ${body.stroke.anchor})`);

  // The threads list loads again and the frame, told its pins, says which it found.
  const matched = await page
    .waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/artifacts/${made.id}/comments/matches`), { timeout: 8000 })
    .catch(async (e) => {
      const pins = await (await page.locator("#preview").elementHandle()).contentFrame().then((f) => f.evaluate(() => document.querySelector("shartifacts-overlay")?.shadowRoot.querySelectorAll(".pin").length));
      const threads = await page.evaluate(() => document.querySelectorAll("#threads .thread").length);
      throw new Error(`${e.message}\nthe frame said: ${(await page.evaluate(() => window.said)).join(", ")}\npins in the frame: ${pins}, threads listed: ${threads}`);
    });
  const report = matched.postDataJSON();
  assert.equal(report.version, 1);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].found, true);
  console.log("SAW the match report posts to /comments/matches for version 1 with the thread found");
  assert.deepEqual(errors, []);
  console.log(`\nOK in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} finally {
  await browser.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
