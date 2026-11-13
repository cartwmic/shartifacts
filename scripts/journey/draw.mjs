// c2: the draw tool inside the sandboxed workspace frame, with a finger on a phone and a
// mouse on a desktop: toggle it, draw, comment, see the thread with its stroke in a second
// session, reply, resolve, wake; scrolling still works with draw off; and a stroke drawn
// after scrolling a long page is stored relative to the page, not to the screen.
import assert from "node:assert/strict";
import { mcpSession, watch } from "./lib.mjs";
import { richPage } from "./fixtures.mjs";
import { SEL, drawAround, enterDraw, expect, openWorkspace, rootOf, settleAtTop, showThreads, strokeAgrees, submitComposer, swipe, tap } from "./ui.mjs";

export async function draw(env) {
  const { step } = env.report;
  const agent = await mcpSession(env.base);
  const sessions = [];
  const scrolled = (ws) => ws.frame.evaluate(() => Math.round(scrollY));
  let id, ws, first, woke;
  try {
    await step("0 publish a long page", async (n) => {
      id = (await agent.call("create_artifact", { title: "Quarterly note", kind: "html", content: richPage({ rev: 1, filler: 6 }) })).id;
      sessions.push((ws = await openWorkspace(env, id)));
      const height = await ws.frame.evaluate(() => document.documentElement.scrollHeight);
      assert.ok(height > 3000, `the page is only ${height}px tall`);
      n.saw(`published ${id}, ${height}px tall, opened at ${env.profile.name}`);
    });

    await step("1 with draw off the page scrolls", async (n) => {
      assert.equal(await scrolled(ws), 0);
      if (env.profile.touch) await swipe(ws, 400);
      else {
        const fb = await ws.page.locator(SEL.frame).boundingBox();
        await ws.page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
        await ws.page.mouse.wheel(0, 400);
      }
      await expect.poll(() => scrolled(ws)).toBeGreaterThan(100);
      const moved = await scrolled(ws);
      await settleAtTop(ws);
      n.saw(`${env.profile.touch ? "a touch swipe" : "the mouse wheel"} moved the frame to scrollY ${moved} with draw off`);
    });

    await step("2 draw, comment, save", async (n) => {
      await enterDraw(env, ws);
      const wake = await watch(env.base, id, "comments");
      const drawn = await drawAround(env, ws, "#chart");
      assert.equal(drawn.after.scroll_y, drawn.before.scroll_y, "the page scrolled while drawing");
      first = await submitComposer(env, ws, id, "Check this chart.", { before: wake.mark });
      woke = await wake.woken();
      const stored = await rootOf(env, id, first.id);
      assert.ok(stored.stroke, "the saved comment has no stroke");
      n.saw(`drew with ${env.profile.touch ? "touch events" : "the mouse"} and the page stayed put; the composer opened and saved: ${await strokeAgrees(ws, stored.stroke, drawn)}`);
      await env.report.shot(ws.page, "2-drawn");
    });

    await step("3 the thread shows with its stroke", async (n) => {
      await showThreads(env, ws, first.id);
      await expect(ws.page.locator(SEL.thread(first.id)).locator(SEL.threadStroke).first()).toBeVisible();
      await env.report.shot(ws.page, "3-thread");
      n.saw("the comments panel lists the thread with a drawing marker");
    });

    await step("4 another session sees it", async (n) => {
      const other = await openWorkspace(env, id);
      sessions.push(other);
      await showThreads(env, other, first.id);
      await expect(other.frame.locator(SEL.savedStroke).first()).toBeAttached();
      await env.report.shot(other.page, "4-second-session");
      n.saw("a second browser session shows the thread and the frame paints the saved stroke");
    });

    await step("5 reply, resolve, wake", async (n) => {
      const other = sessions[1];
      const wake = await watch(env.base, id, "comments");
      const thread = other.page.locator(SEL.thread(first.id));
      await tap(env, thread.locator(SEL.reply));
      await thread.locator(SEL.replyText).fill("Looks right to me.");
      wake.mark();
      await tap(env, thread.locator(SEL.replySend));
      const replied = await wake.woken();
      await tap(env, thread.locator(SEL.resolve));
      await expect.poll(async () => (await agent.call("artifact_comments", { id, op: "list", all: true })).threads[0].resolved).toBe(true);
      const { threads } = await agent.call("artifact_comments", { id, op: "list", all: true });
      assert.equal(threads[0].replies.length, 1);
      n.saw(`reply and resolve from the second session reached the agent; the reply woke it in ${replied.ms} ms (the drawn comment woke it in ${woke.ms} ms)`);
    });

    await step("6 a stroke after scrolling", async (n) => {
      const late = await openWorkspace(env, id);
      sessions.push(late);
      await enterDraw(env, late);
      const drawn = await drawAround(env, late, "#cell-south-q1");
      assert.ok(drawn.before.scroll_y > 500, `the page is only scrolled to ${drawn.before.scroll_y}`);
      assert.equal(drawn.after.scroll_y, drawn.before.scroll_y, "the page scrolled while drawing");
      const comment = await submitComposer(env, late, id, "This cell, far down the page.");
      const stored = await rootOf(env, id, comment.id);
      n.saw(`drawn at scrollY ${drawn.before.scroll_y}; stored relative to the page: ${await strokeAgrees(late, stored.stroke, drawn)}`);
      await env.report.shot(late.page, "6-scrolled-stroke");
    });
  } finally {
    for (const s of sessions) await s.close();
    await agent.close();
  }
}
