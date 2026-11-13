// Driving the workspace like a person: opening an artifact, selecting text, drawing with a
// finger or a mouse, using the composer. The selectors are in one table so a change in the
// pieces that were built separately is one edit here.
import { expect as playwrightExpect } from "@playwright/test";
import assert from "node:assert/strict";
import { api } from "./lib.mjs";

export const expect = playwrightExpect.configure({ timeout: 15000 });

export const SEL = {
  // The workspace page (web/index.html, web/app.js): known.
  frame: "#preview",
  commentMode: "#comment-mode",
  commentsLink: "#comments-link",
  composer: "#comment-popover",
  composerText: "#comment-popover textarea[name=body]",
  composerSendAgent: '#comment-popover button[value="agent"]',
  threadsPanel: "#threads",
  thread: (id) => `#threads .thread[data-id="${id}"]`,
  reply: ".thread-actions button:text-is('Reply')",
  replyText: ".reply-form textarea",
  replySend: ".reply-form button.primary",
  resolve: ".thread-actions button:text-is('Resolve')",
  threadComments: ".comment",
  // Inside the frame (web/runtime.js overlay: an open shadow root, which CSS pierces): known.
  chip: "shartifacts-overlay button.chip",
  // The draw tool in the overlay was built apart from this script. These three are written
  // from DESIGN.md ("toggle buttons in the overlay: Comment / Draw") and may need adjusting:
  // the Draw toggle, how it shows it is on, and the saved stroke the frame paints for an
  // open thread.
  drawToggle: 'shartifacts-overlay button:text-is("Draw")',
  drawOnAttr: ["aria-pressed", "true"],
  savedStroke: "shartifacts-overlay svg path",
  // How a thread in the panel shows that it has a drawing, and that it was lost.
  threadStroke: ".stroke-thumb",
  threadLost: ".thread-unplaced",
};

// A touch device taps; a mouse clicks.
export const tap = (env, locator) => (env.profile.touch ? locator.tap() : locator.click());
// For the workspace's own buttons: after raw CDP touch events (a swipe or a stroke) Playwright's
// tap can be swallowed by the browser's touch state, so these are plain clicks. The strokes and the
// swipe are the touch input under test; pressing Send is not.
export const press = (locator) => locator.click();

// A freshly loaded preview is an out-of-process frame; Chrome routes input into it only
// once its hit-test data catches up, slightly after load. Until then a press lands on the
// parent's <iframe>. Wait until a pointer move is actually received inside.
export async function routed(page) {
  const body = page.frameLocator(SEL.frame).locator("body");
  await body.evaluate(() => {
    window.__routed = false;
    addEventListener("pointermove", () => (window.__routed = true), { once: true });
  });
  const box = await page.locator(SEL.frame).boundingBox();
  let step = 0;
  await expect.poll(async () => {
    await page.mouse.move(box.x + 4 + (step++ % 2), box.y + box.height - 4);
    return body.evaluate(() => window.__routed);
  }).toBe(true);
}

// Opens an artifact in the workspace in a browser of its own (a separate viewer, with no
// storage in common with any other) and waits until its frame is live and takes input.
export async function openWorkspace(env, id, { version } = {}) {
  const ctx = await env.browser.newContext(env.profile.context);
  ctx.setDefaultTimeout(15000);
  const page = env.report.track(await ctx.newPage());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  page.on("requestfailed", (r) => errors.push(`request failed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(`${env.base}/a/${id}${version ? `?version=${version}` : ""}`);
  await expect(page.locator(SEL.frame)).toHaveAttribute("data-ready", "true");
  await routed(page);
  const frame = await (await page.locator(SEL.frame).elementHandle()).contentFrame();
  return { ctx, page, frame, errors, close: () => ctx.close() };
}

// ---- text -----------------------------------------------------------------------------
// Selects `phrase` inside the element at `selector` with a Range: a finger's long-press
// selection cannot be made in headless Chromium, so that part is assumed, not seen.
export async function selectText(ws, selector, phrase) {
  await ws.frame.evaluate(([selector, phrase]) => {
    const el = document.querySelector(selector);
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.data.includes(phrase));
    const at = node.data.indexOf(phrase);
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + phrase.length);
    el.scrollIntoView({ block: "center" });
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, [selector, phrase]);
}

// Sends what the composer holds and returns the comment the server made. `before` runs
// right before the press that sends it, so a wake can be timed from there.
export async function submitComposer(env, ws, id, text, { before } = {}) {
  await expect(ws.page.locator(SEL.composer)).toBeVisible();
  await ws.page.locator(SEL.composerText).fill(text);
  const posted = ws.page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/artifacts/${id}/comments`));
  before?.();
  const send = ws.page.locator(SEL.composerSendAgent);
  const where = await send.boundingBox();
  await press(send);
  const res = await posted.catch(async (e) => {
    const top = await ws.page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el ? `${el.tagName}#${el.id}.${el.className}` : "nothing";
    }, { x: where.x + where.width / 2, y: where.y + where.height / 2 });
    throw new Error(`${e.message.split("\n")[0]}; the send button was at ${JSON.stringify(where)}, the topmost element there was ${top}; the page logged: ${JSON.stringify(ws.errors)}`);
  });
  assert.equal(res.status(), 201, "the comment was refused: " + (await res.text()));
  return res.json();
}

// Comments on a phrase: select it, press the Comment chip, write, send.
export async function commentOnText(env, ws, id, selector, phrase, text, opts) {
  await selectText(ws, selector, phrase);
  await tap(env, ws.frame.locator(SEL.chip));
  return submitComposer(env, ws, id, text, opts);
}

// ---- drawing --------------------------------------------------------------------------
// Where the frame is scrolled and how big it is: the numbers a stroke records.
export const metrics = (ws) =>
  ws.frame.evaluate(() => ({ w: innerWidth, h: innerHeight, scroll_x: Math.round(scrollX), scroll_y: Math.round(scrollY) }));

// An element's box in document coordinates, and the element a CSS path finds (or null).
export const docBox = (ws, selector) =>
  ws.frame.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  }, selector);

// Brings an element to the middle of the frame and returns its box in frame (viewport)
// coordinates once the scroll has landed, plus the scroll it took.
export async function reveal(ws, selector) {
  return ws.frame.evaluate(async (selector) => {
    const el = document.querySelector(selector);
    el.scrollIntoView({ block: "center", inline: "nearest" });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, scroll_y: Math.round(scrollY) };
  }, selector);
}

// A loop around a box, a little wider than it, closing past its start: a circle as a
// person draws one.
export function loopAround(r, pad = 14, n = 40) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rx = r.w / 2 + pad, ry = r.h / 2 + pad;
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * 2 * Math.PI * 1.08 - Math.PI / 2;
    return [+(cx + rx * Math.cos(a)).toFixed(1), +(cy + ry * Math.sin(a)).toFixed(1)];
  });
}

const cdpOf = async (ws) => (ws.cdp ??= await ws.ctx.newCDPSession(ws.page));

// Draws a path given in frame coordinates: touch events on a phone, a pressed mouse on a
// desktop. Both go through the browser's input, so the page sees pointer events as real.
export async function drawPath(env, ws, pts) {
  const fb = await ws.page.locator(SEL.frame).boundingBox();
  const at = pts.map(([x, y]) => ({ x: fb.x + x, y: fb.y + y }));
  if (env.profile.touch) {
    const cdp = await cdpOf(ws);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at[0]] });
    for (const p of at.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await ws.page.mouse.move(at[0].x, at[0].y);
    await ws.page.mouse.down();
    for (const p of at.slice(1)) await ws.page.mouse.move(p.x, p.y);
    await ws.page.mouse.up();
  }
}

// A swipe up the screen as a finger does it: touch events with moves in between, which
// the browser turns into a scroll if the page lets it. (CDP's synthesized scroll gesture
// does not reach a framed page, so it cannot stand in.)
export async function swipe(ws, dy) {
  const fb = await ws.page.locator(SEL.frame).boundingBox();
  const cdp = await cdpOf(ws);
  const x = fb.x + fb.width / 2;
  let y = fb.y + fb.height * 0.7;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let moved = 0; moved < dy; moved += 20) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: (y -= 20) }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// Puts the frame back at the top and waits until it stays there for ten frames: a swipe
// leaves a fling running, and a finger that lands on a flinging page only stops it.
export async function settleAtTop(ws) {
  await ws.frame.evaluate(
    () =>
      new Promise((done) => {
        let still = 0;
        const frame = () => {
          if (scrollY === 0) still += 1;
          else {
            still = 0;
            scrollTo(0, 0);
          }
          still >= 10 ? done() : requestAnimationFrame(frame);
        };
        frame();
      }),
  );
}

// Turns draw on: the Comment/Draw toggles live in the frame's overlay, which the
// workspace shows once comment mode is on.
export async function enterDraw(env, ws) {
  const toggle = ws.frame.locator(SEL.drawToggle);
  // Tap comment mode only when it is off: its button says which, and a second tap would turn it off again.
  const mode = ws.page.locator(SEL.commentMode);
  if ((await mode.getAttribute("aria-pressed")) !== "true") await press(mode);
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toBeVisible();
  const where = await toggle.boundingBox();
  await tap(env, toggle);
  await expect(toggle).toHaveAttribute(...SEL.drawOnAttr).catch(async (e) => {
    const top = await ws.page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el ? `${el.tagName}#${el.id}.${el.className}` : "nothing";
    }, { x: where.x + where.width / 2, y: where.y + where.height / 2 });
    throw new Error(`${e.message.split("\n")[0]}; the toggle was at ${JSON.stringify(where)}, the topmost element there was ${top}, comment mode is ${await mode.getAttribute("aria-pressed")}`);
  });
}

// Scrolls to `selector`, draws a loop around it and opens the composer, as one person
// action; returns what the journey needs to check against what the server stored.
export async function drawAround(env, ws, selector) {
  const target = await reveal(ws, selector);
  const before = await metrics(ws);
  const input = loopAround(target);
  await drawPath(env, ws, input);
  const after = await metrics(ws);
  return { target, before, after, input };
}

// ---- reading back ---------------------------------------------------------------------
export const restComments = (env, id) => api(env.base, `/api/artifacts/${id}/comments`);
export const rootOf = async (env, id, commentId) => (await restComments(env, id)).find((c) => c.id === commentId);

// Opens the comments panel (on a phone it covers the page) and waits for a thread.
export async function showThreads(env, ws, id) {
  if ((await ws.page.locator(SEL.commentsLink).getAttribute("aria-expanded")) !== "true") await press(ws.page.locator(SEL.commentsLink));
  await expect(ws.page.locator(SEL.thread(id))).toBeVisible();
}

// Checks a stored stroke against what was drawn, by re-resolving it in the page: the
// numbers it recorded must be those of the frame when it was drawn, its anchor must still
// find an element with the box it recorded, and its points (relative to that box) must
// land on the path that was drawn, in document coordinates, scroll included.
export async function strokeAgrees(ws, stroke, drawn, tolerance = 6) {
  assert.equal(stroke.v, 1);
  assert.equal(stroke.viewport.w, drawn.before.w, "stroke.viewport.w");
  assert.equal(stroke.viewport.h, drawn.before.h, "stroke.viewport.h");
  assert.ok(Math.abs(stroke.viewport.scroll_y - drawn.before.scroll_y) <= 1, `stroke.viewport.scroll_y ${stroke.viewport.scroll_y} vs scrolled ${drawn.before.scroll_y}`);
  const el = await docBox(ws, stroke.anchor);
  assert.ok(el, `stroke.anchor ${stroke.anchor} finds no element`);
  for (const k of ["x", "y", "w", "h"]) assert.ok(Math.abs(el[k] - stroke.box[k]) <= 2, `stroke.box.${k} ${stroke.box[k]} vs the element's ${el[k]}`);
  const bounds = (pts) => ({ x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) });
  const kept = bounds(stroke.points.map(([dx, dy]) => [stroke.box.x + dx, stroke.box.y + dy]));
  const made = bounds(drawn.input.map(([x, y]) => [x + drawn.before.scroll_x, y + drawn.before.scroll_y]));
  for (const k of Object.keys(made)) assert.ok(Math.abs(kept[k] - made[k]) <= tolerance, `recorded path ${k} ${kept[k].toFixed(1)} vs drawn ${made[k].toFixed(1)} (document coordinates)`);
  return `${stroke.points.length} points, anchor ${stroke.anchor}, viewport ${stroke.viewport.w}x${stroke.viewport.h} scrolled ${stroke.viewport.scroll_y}, path within ${tolerance}px of what was drawn`;
}
