// The draw tool and the match reports in the preview overlay (web/runtime.js), in Chrome,
// with no shartifacts server: a stand-in workspace page frames a test page the way the
// real one frames a preview (an opaque-origin sandbox under the same script rules) and
// sends it the `shartifacts-comments` messages. Covers how a stroke is anchored and saved,
// redrawing it at another width, the touch-action toggle and the found rules.
// Run with `node scripts/draw-unit-test.mjs`.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const started = Date.now();
const webFile = (name) => new URL(`../web/${name}`, import.meta.url);

const parentHtml = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><iframe id="f" sandbox="allow-scripts" src="/page.html" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>
<script>
window.log = [];
addEventListener("message", (e) => e.source === f.contentWindow && log.push(e.data));
window.tell = (m) => f.contentWindow.postMessage(m, "*");
</script>`;
// Three bars in a drawing that scales with its width, below long stretches of page, so a
// stroke is drawn after scrolling a long way and drawn again where the layout differs.
const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="/runtime.js"></script>
<style>body{margin:0;font:16px/1.5 sans-serif}.pad{height:1500px;background:linear-gradient(#fff,#ddd)}p{margin:12px 24px}#chart{margin:0 24px;max-width:800px}#chart svg{display:block;width:100%;height:auto}#grid{margin:0 24px;display:flex;width:320px}#grid i{display:block;width:8px;height:30px;background:#9bd}</style></head><body>
<h1 id="title">Quarterly report</h1>
<p id="copy">Revenue <b id="grew">grew</b> in Q2.</p>
<p id="other">Costs stayed flat.</p>
<p id="long">${"word ".repeat(80)}</p>
<div id="grid">${"<i>x</i>".repeat(40)}</div>
<div class="pad"></div>
<div id="chart"><svg viewBox="0 0 300 150"><rect class="bar" x="20" y="60" width="70" height="80" fill="#69c"/><rect class="bar" x="115" y="30" width="70" height="110" fill="#c96"/><rect class="bar" x="210" y="50" width="70" height="90" fill="#6c9"/></svg></div>
<div class="pad"></div></body></html>`;

let origin = "";
const server = createServer(async (req, res) => {
  const send = (type, body, extra = {}) => {
    res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*", ...extra });
    res.end(body);
  };
  if (req.url === "/parent.html") return send("text/html", parentHtml);
  // The rules a preview is served under, so the pen loads here only where it would there.
  if (req.url === "/page.html")
    return send("text/html", pageHtml, {
      "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${origin}/vendor/ ${origin}/runtime.js; style-src 'unsafe-inline'; sandbox allow-scripts`,
    });
  if (req.url === "/runtime.js") return send("text/javascript", await readFile(webFile("runtime.js")));
  if (req.url === "/vendor/freehand.js") return send("text/javascript", await readFile(webFile("vendor/freehand.js")));
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const desktop = { viewport: { width: 1280, height: 800 } };

async function open(options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(origin + "/parent.html");
  const fr = await (await page.waitForSelector("#f")).contentFrame();
  await fr.waitForFunction(() => !!window.claude);
  return { context, page, fr, errors };
}
// Says what the workspace would: comment mode on or off, the pins, the version shown.
const tell = (s, m = {}) =>
  s.page.evaluate((m) => tell({ type: "shartifacts-comments", enabled: true, mode: false, pins: [], active: "", pending: false, version: 3, ...m }), m);
const mark = (s) => s.page.evaluate(() => log.length);
const next = async (s, type, from) => {
  await s.page.waitForFunction(([t, i]) => log.slice(i).some((m) => m.type === t), [type, from]);
  return s.page.evaluate(([t, i]) => log.slice(i).find((m) => m.type === t), [type, from]);
};
const count = (s, type, from) => s.page.evaluate(([t, i]) => log.slice(i).filter((m) => m.type === t).length, [type, from]);
const inOverlay = (s, fn) => s.fr.evaluate(`(${fn})(document.querySelector("shartifacts-overlay").shadowRoot)`);
const gone = (s, selector) => s.fr.waitForFunction((sel) => !document.querySelector("shartifacts-overlay").shadowRoot.querySelector(sel), selector);
const rectOf = (s, selector, n = 0) =>
  s.fr.evaluate(([sel, n]) => {
    const r = document.querySelectorAll(sel)[n].getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }, [selector, n]);
const reveal = (s, selector, n = 0) => s.fr.evaluate(([sel, n]) => document.querySelectorAll(sel)[n].scrollIntoView({ block: "center", behavior: "instant" }), [selector, n]);
const scrollTo = (s, y) => s.fr.evaluate((y) => scrollTo(0, y), y);
// The one drawn stroke, once its pin shows that the thread has been placed.
const inkBox = async (s, pin) => {
  await s.fr.getByRole("button", { name: `Open comment ${pin}` }).waitFor();
  return inOverlay(s, (root) => {
    const paths = root.querySelectorAll(".ink path");
    if (paths.length !== 1) throw new Error(`${paths.length} strokes are drawn`);
    const r = paths[0].getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
};
const circle = (cx, cy, r, n = 28) => Array.from({ length: n + 1 }, (_, i) => [Math.round(cx + r * Math.cos((2 * Math.PI * i) / n)), Math.round(cy + r * Math.sin((2 * Math.PI * i) / n))]);
const line = (x0, y0, x1, y1, n = 24) => Array.from({ length: n + 1 }, (_, i) => [Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n)]);
async function stroke(s, pts) {
  await s.page.mouse.move(...pts[0]);
  await s.page.mouse.down();
  // Queued together: a long stroke is thousands of moves.
  await Promise.all(pts.slice(1).map((p) => s.page.mouse.move(...p)));
  await s.page.mouse.up();
}
// Comment mode on with the Draw tool chosen, as a person gets there.
async function startDrawing(s) {
  await tell(s, { mode: true });
  await s.fr.getByRole("button", { name: "Draw" }).click();
  await s.fr.waitForFunction(() => document.querySelector("shartifacts-overlay").shadowRoot.querySelector(".capture.on"));
}
// Resolves once the page has stopped moving: a swipe's fling runs on after the finger.
const settled = (s) =>
  s.fr.evaluate(
    () =>
      new Promise((resolve) => {
        let last = -1,
          same = 0;
        const tick = () => {
          same = scrollY === last ? same + 1 : 0;
          last = scrollY;
          same >= 8 ? resolve(scrollY) : requestAnimationFrame(tick);
        };
        tick();
      }),
  );
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

const steps = [];
const failures = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    steps.push(name);
    console.log(`SAW ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name} (${Date.now() - t} ms)\n${String(e.stack || e).split("\n").slice(0, 6).join("\n")}`);
  }
};

try {
  const a = await open(phone);
  let around, under;

  await step("touch-action is none only while Draw is on; a touch swipe scrolls with it off and a finger draws with it on", async () => {
    const state = () =>
      inOverlay(a, (root) => {
        const c = getComputedStyle(root.querySelector(".capture"));
        return { display: c.display, touchAction: c.touchAction, tools: getComputedStyle(root.querySelector(".tools")).display };
      });
    await tell(a, { mode: true });
    await a.fr.getByRole("button", { name: "Draw" }).waitFor();
    assert.deepEqual(await state(), { display: "none", touchAction: "auto", tools: "flex" }, "comment mode, Draw not chosen");
    const cdp = await a.context.newCDPSession(a.page);
    const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
    // A finger dragging up the screen, which the browser reads as a scroll unless touch-action forbids it.
    const swipe = async () => {
      const path = line(200, 700, 200, 400, 15);
      await touch("touchStart", [path[0]]);
      for (const p of path.slice(1)) await touch("touchMove", [p]);
      await touch("touchEnd", []);
    };
    await swipe();
    await a.fr.waitForFunction(() => scrollY > 100);
    await settled(a);
    await scrollTo(a, 400);
    await settled(a);
    await a.fr.getByRole("button", { name: "Draw" }).click();
    await a.fr.waitForFunction(() => document.querySelector("shartifacts-overlay").shadowRoot.querySelector(".capture.on"));
    assert.deepEqual(await state(), { display: "block", touchAction: "none", tools: "flex" }, "Draw on");
    await swipe();
    assert.equal(await settled(a), 400, "a swipe on the capture layer must not scroll the page");
    await scrollTo(a, 0);
    const from = await mark(a);
    const path = line(60, 300, 330, 380, 12);
    await touch("touchStart", [path[0]]);
    for (const p of path.slice(1)) await touch("touchMove", [p]);
    await touch("touchEnd", []);
    assert.ok((await next(a, "shartifacts-comment-pick", from)).stroke.points.length >= 12, "a finger's stroke is saved");
    await a.fr.getByRole("button", { name: "Comment" }).click();
    await a.fr.waitForFunction(() => !document.querySelector("shartifacts-overlay").shadowRoot.querySelector(".capture.on"));
    assert.deepEqual(await state(), { display: "none", touchAction: "auto", tools: "flex" }, "back to Comment");
    await swipe();
    await a.fr.waitForFunction(() => scrollY > 100);
    await settled(a);
    await tell(a, { mode: false });
    await a.fr.waitForFunction(() => getComputedStyle(document.querySelector("shartifacts-overlay").shadowRoot.querySelector(".tools")).display === "none");
  });

  await step("a stroke drawn after scrolling a long page is anchored to the smallest element and saved relative to its box", async () => {
    await reveal(a, "#chart rect", 1);
    await startDrawing(a);
    const bar = await rectOf(a, "#chart rect", 1);
    const scroll = await a.fr.evaluate(() => scrollY);
    assert.ok(scroll > 800, `the page is scrolled a long way (${scroll})`);
    const pts = circle(Math.round((bar.left + bar.right) / 2), Math.round((bar.top + bar.bottom) / 2), 76);
    const from = await mark(a);
    await stroke(a, pts);
    const m = await next(a, "shartifacts-comment-pick", from);
    around = m;
    const s = m.stroke;
    assert.equal(m.quote, "");
    assert.equal(m.text, false);
    assert.equal(m.anchor, "#chart > svg > rect:nth-of-type(2)");
    assert.equal(s.anchor, m.anchor);
    assert.ok(m.element.startsWith("<rect"), m.element);
    assert.equal(s.v, 1);
    assert.deepEqual(s.viewport, { w: 390, h: 844, scroll_x: 0, scroll_y: scroll });
    // The box is the bar's in document coordinates, not in the viewport.
    near(s.box.x, bar.left, 0.2, "box.x");
    near(s.box.y, bar.top + scroll, 0.2, "box.y (document, not viewport)");
    near(s.box.w, bar.width, 0.2, "box.w");
    near(s.box.h, bar.height, 0.2, "box.h");
    // Every saved point plus the box corner is a place the pointer was, in the document.
    assert.ok(s.points.length >= 20);
    for (const [dx, dy, pressure] of s.points) {
      assert.equal(pressure, 0.5);
      const x = s.box.x + dx,
        y = s.box.y + dy - scroll;
      assert.ok(pts.some(([px, py]) => Math.abs(px - x) <= 0.2 && Math.abs(py - y) <= 0.2), `point ${dx},${dy} is not where the pointer was`);
    }
    assert.equal(s.color, "#d33");
    assert.equal(s.width, 4);
    assert.ok(!s.anchor.includes("shartifacts-overlay"));
    // Elements under the stroke: deepest first, never html or body, each with the three fields.
    assert.ok(s.elements.length >= 2 && s.elements.length <= 20);
    assert.ok(s.elements.some((e) => e.path === "#chart > svg") && s.elements.some((e) => e.path === "#chart"));
    const depths = await a.fr.evaluate((paths) => paths.map((p) => { let n = 0; for (let e = document.querySelector(p); e; e = e.parentElement) n++; return n; }), s.elements.map((e) => e.path));
    assert.deepEqual(depths, [...depths].sort((x, y) => y - x), "deepest first");
    for (const e of s.elements) assert.ok(e.tag.startsWith("<") && e.text.length <= 120 && !["html", "body"].includes(e.path));
  });

  await step("the middle of the stroke picks the smallest element: an inline word, then its paragraph", async () => {
    await scrollTo(a, 0);
    const grew = await rectOf(a, "#grew");
    let from = await mark(a);
    await stroke(a, circle(Math.round((grew.left + grew.right) / 2), Math.round((grew.top + grew.bottom) / 2), 9, 12));
    assert.equal((await next(a, "shartifacts-comment-pick", from)).anchor, "#grew");
    const copy = await rectOf(a, "#copy");
    from = await mark(a);
    await stroke(a, line(Math.round(copy.right - 80), Math.round(copy.top + 10), Math.round(copy.right - 30), Math.round(copy.top + 14)));
    assert.equal((await next(a, "shartifacts-comment-pick", from)).anchor, "#copy");
  });

  await step("elements under a line across three bars lists all three before their drawing, and is cut at 20", async () => {
    await reveal(a, "#chart rect", 1);
    const [b1, b3] = [await rectOf(a, "#chart rect", 0), await rectOf(a, "#chart rect", 2)];
    const y = Math.round((b1.top + b1.bottom) / 2) + 10;
    let from = await mark(a);
    await stroke(a, line(Math.round(b1.left) - 6, y, Math.round(b3.right) + 6, y, 40));
    const paths = (await next(a, "shartifacts-comment-pick", from)).stroke.elements.map((e) => e.path);
    for (const n of [1, 2, 3]) assert.ok(paths.includes(`#chart > svg > rect:nth-of-type(${n})`), `bar ${n} is under the line: ${paths}`);
    assert.ok(paths.indexOf("#chart > svg > rect:nth-of-type(1)") < paths.indexOf("#chart > svg"), "bars before their drawing");
    await scrollTo(a, 0);
    const grid = await rectOf(a, "#grid");
    from = await mark(a);
    await stroke(a, line(Math.round(grid.left) + 2, Math.round(grid.top) + 15, Math.round(grid.right) - 2, Math.round(grid.top) + 15, 60));
    const cells = (await next(a, "shartifacts-comment-pick", from)).stroke.elements;
    assert.equal(cells.length, 20);
    assert.ok(cells.every((e) => e.tag === "<i>"), "the cells, not their row, fill the 20");
    from = await mark(a);
    const long = await rectOf(a, "#long");
    await stroke(a, line(Math.round(long.left) + 4, Math.round(long.top) + 10, Math.round(long.left) + 60, Math.round(long.top) + 12));
    const text = (await next(a, "shartifacts-comment-pick", from)).stroke.elements.find((e) => e.path === "#long").text;
    assert.equal(text.length, 120);
  });

  await step("a tap is not a drawing, Escape drops a stroke being drawn, then clears the finished one, then leaves comment mode, and Undo clears too", async () => {
    await scrollTo(a, 0);
    // The stroke left waiting by the steps before is dropped, as closing the composer does.
    await tell(a, { mode: true, pending: false });
    await gone(a, ".ink path");
    const from = await mark(a);
    await stroke(a, line(100, 300, 104, 303, 3));
    await a.page.mouse.move(100, 300);
    await a.page.mouse.down();
    await Promise.all(line(100, 300, 250, 400, 10).slice(1).map((p) => a.page.mouse.move(...p)));
    await a.fr.waitForFunction(() => document.querySelector("shartifacts-overlay").shadowRoot.querySelectorAll(".ink path").length === 1);
    await a.page.keyboard.press("Escape");
    await gone(a, ".ink path");
    await a.page.mouse.up();
    await stroke(a, line(100, 500, 300, 520, 10));
    await next(a, "shartifacts-comment-pick", from);
    assert.equal(await count(a, "shartifacts-comment-pick", from), 1, "only the stroke that was finished");
    assert.equal(await count(a, "shartifacts-comment-exit", from), 0, "Escape stopped at the stroke");
    const at = await mark(a);
    await a.fr.getByRole("button", { name: "Undo" }).click();
    await next(a, "shartifacts-comment-clear", at);
    await gone(a, ".ink path");
    const at2 = await mark(a);
    await stroke(a, line(100, 500, 300, 520, 10));
    await next(a, "shartifacts-comment-pick", at2);
    await a.page.keyboard.press("Escape");
    await next(a, "shartifacts-comment-clear", at2);
    await a.page.keyboard.press("Escape");
    await next(a, "shartifacts-comment-exit", at2);
  });

  await step("scrolling in the middle of a stroke does not bend it", async () => {
    await scrollTo(a, 0);
    const from = await mark(a);
    await a.page.mouse.move(100, 300);
    await a.page.mouse.down();
    await Promise.all(line(100, 300, 160, 330, 6).slice(1).map((p) => a.page.mouse.move(...p)));
    await a.fr.evaluate(() => scrollBy(0, 200));
    await Promise.all(line(160, 330, 220, 360, 6).slice(1).map((p) => a.page.mouse.move(...p)));
    await a.page.mouse.up();
    const s = (await next(a, "shartifacts-comment-pick", from)).stroke;
    near(s.points.at(-1)[1] - s.points[0][1], 360 - 300 + 200, 0.3, "document distance covered");
    assert.equal(s.viewport.scroll_y, 200);
  });

  await step("a long stroke is cut to at most 3000 points and stays under the store's size limit", async () => {
    await scrollTo(a, 0);
    const from = await mark(a);
    const pts = [];
    for (let i = 0; i < 30; i++) pts.push(...line(i % 2 ? 380 : 10, 100 + i * 12, i % 2 ? 10 : 380, 100 + i * 12, 110));
    await stroke(a, pts);
    const s = (await next(a, "shartifacts-comment-pick", from)).stroke;
    assert.ok(s.points.length <= 3000 && s.points.length > 1500, `${s.points.length} points`);
    assert.ok(JSON.stringify(s).length < 96 * 1024, "under 96 KiB");
    near(s.points.at(-1)[1] - s.points[0][1], 29 * 12, 0.3, "the end of the stroke is kept");
  });

  await step("a saved stroke follows its anchor's current box: moved, and drawn at 390 shown at 1280 on the same content", async () => {
    // An underline from the second bar's left to the third bar's right.
    await reveal(a, "#chart rect", 1);
    await tell(a, { mode: true });
    const [b2, b3] = [await rectOf(a, "#chart rect", 1), await rectOf(a, "#chart rect", 2)];
    const y = Math.round(b2.bottom) + 8;
    const from = await mark(a);
    await stroke(a, line(Math.round(b2.left), y, Math.round(b3.right), y, 30));
    under = (await next(a, "shartifacts-comment-pick", from)).stroke;
    assert.equal(under.anchor, "#chart > svg", "the middle of the underline is below the bars");
    await tell(a, { mode: false, pins: [{ id: "c1", n: 1, anchor: under.anchor, quote: "", stroke: under }] });
    const ink = await inkBox(a, 1);
    near(ink.left, b2.left, 4, "starts at the second bar (390)");
    near(ink.right, b3.right, 4, "ends at the third bar (390)");
    const below = ink.top + ink.height / 2 - b2.bottom;
    // The element moves and the drawing goes with it.
    await a.fr.evaluate(() => (document.querySelector("#chart").style.marginTop = "180px"));
    const moved = await rectOf(a, "#chart rect", 1);
    assert.ok(moved.top > b2.top + 100);
    await a.fr.waitForFunction(
      (want) => {
        const r = document.querySelector("shartifacts-overlay").shadowRoot.querySelector(".ink path").getBoundingClientRect();
        return Math.abs(r.top + r.height / 2 - want) < 2;
      },
      moved.bottom + below,
    );
    // The same stroke on a 1280 wide screen: drawn on the phone, shown on the desktop.
    const d = await open(desktop);
    await tell(d, { pins: [{ id: "c1", n: 1, anchor: under.anchor, quote: "", stroke: under }] });
    await reveal(d, "#chart rect", 1);
    const [d2, d3] = [await rectOf(d, "#chart rect", 1), await rectOf(d, "#chart rect", 2)];
    assert.ok(d2.width > 2 * b2.width, `the drawing is much bigger on the desktop (${d2.width} against ${b2.width})`);
    const wide = await inkBox(d, 1);
    near(wide.left, d2.left, 6, "starts at the second bar (1280)");
    near(wide.right, d3.right, 6, "ends at the third bar (1280)");
    near(wide.top + wide.height / 2 - d2.bottom, below * (d2.width / b2.width), 3, "its distance under the bars scales with them");
    // A circle drawn around the second bar on the phone surrounds it on the desktop.
    await tell(d, { pins: [{ id: "c2", n: 2, anchor: around.anchor, quote: "", stroke: around.stroke }] });
    const circled = await inkBox(d, 2);
    assert.ok(circled.left < d2.left && circled.right > d2.right && circled.top < d2.top && circled.bottom > d2.bottom, "surrounds the bar");
    const opened = await mark(d);
    await d.fr.getByRole("button", { name: "Open comment 2" }).click();
    assert.equal((await next(d, "shartifacts-comment-open", opened)).id, "c2");
    assert.deepEqual(d.errors, []);
    await d.context.close();
  });

  await step("found rules: a quote must be on the page (reworded is lost), a drawing needs its anchor, an anchor alone needs its element", async () => {
    const b = await open(phone);
    const pin = (id, anchor, quote, s) => ({ id, n: 1, anchor, quote, ...(s ? { stroke: s } : {}) });
    const pins = [
      pin("quote-here", "#copy", "Revenue grew"),
      pin("quote-reworded", "#copy", "Revenue shrank"),
      pin("quote-moved", "#other", "Revenue grew in Q2."),
      pin("quote-nowhere", "#gone", "Nothing like this"),
      pin("draw-here", under.anchor, "", under),
      pin("draw-lost", "#gone", "", { ...under, anchor: "#gone" }),
      pin("anchor-here", "#title", ""),
      pin("anchor-lost", "#gone", ""),
    ];
    let from = await mark(b);
    await tell(b, { pins });
    const m = await next(b, "shartifacts-comment-match", from);
    assert.equal(m.version, 3);
    assert.deepEqual(Object.fromEntries(m.results.map((r) => [r.id, r.found])), {
      "quote-here": true,
      "quote-reworded": false,
      "quote-moved": true,
      "quote-nowhere": false,
      "draw-here": true,
      "draw-lost": false,
      "anchor-here": true,
      "anchor-lost": false,
    });
    const placed = await next(b, "shartifacts-comment-placed", from);
    assert.deepEqual([...placed.missing].sort(), ["anchor-lost", "draw-lost", "quote-nowhere", "quote-reworded"], "the workspace is told which threads are not found");
    // Rewording the page after it is shown changes what is reported, once it settles.
    from = await mark(b);
    await b.fr.evaluate(() => (document.querySelector("#copy").innerHTML = "Revenue <b id='grew'>fell</b> in Q2."));
    const again = Object.fromEntries((await next(b, "shartifacts-comment-match", from)).results.map((r) => [r.id, r.found]));
    assert.equal(again["quote-here"], false);
    assert.equal(again["quote-moved"], false);
    assert.equal(again["anchor-here"], true);
    assert.deepEqual(b.errors, []);
    await b.context.close();
  });

  assert.deepEqual(a.errors, []);
  console.log(`\n${failures.length ? "FAILED" : "OK"} ${steps.length} of ${steps.length + failures.length} steps in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
