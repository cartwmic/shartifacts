// A1-A5 of the annotation journey on a phone: comment on selected text, circle part of the page and
// comment, the agent reads it all back (and gets a picture), the page changes and the
// agent sees which comments lost their place, then replies and resolves.
import assert from "node:assert/strict";
import path from "node:path";
import { mcpSession, noteImage, pngSize, watch } from "./lib.mjs";
import { richPage } from "./fixtures.mjs";
import { commentOnText, drawAround, enterDraw, openWorkspace, restComments, rootOf, submitComposer, strokeAgrees } from "./ui.mjs";

export async function annot(env) {
  const { step } = env.report;
  const agent = await mcpSession(env.base);
  let id, ws, kept, reworded, drawing, drawn, woke;
  const status = async () => Object.fromEntries((await restComments(env, id)).filter((c) => !c.parent).map((c) => [c.id, c.status]));
  try {
    await step("0 publish", async (n) => {
      id = (await agent.call("create_artifact", { title: "Quarterly note", kind: "html", content: richPage({ rev: 1 }) })).id;
      ws = await openWorkspace(env, id);
      n.saw(`published ${id} and opened it in the workspace at ${env.profile.name}`);
    });

    await step("A1 select text and comment", async (n) => {
      const wake = await watch(env.base, id, "comments");
      kept = await commentOnText(env, ws, id, "#keep", "finished on schedule", "Which regions does this cover?", { before: wake.mark });
      woke = await wake.woken();
      reworded = await commentOnText(env, ws, id, "#reword", "dropped by a third", "Where does the third come from?");
      const stored = await rootOf(env, id, kept.id);
      assert.equal(stored.quote, "finished on schedule");
      assert.ok(stored.anchor.includes("keep"), `anchor ${stored.anchor}`);
      assert.match(stored.element, /^<p /);
      await env.report.shot(ws.page, "A1-after-comments");
      n.saw(`two comments saved; the first has quote "${stored.quote}", anchor ${stored.anchor}, element ${stored.element.slice(0, 40)}`);
      n.assumed("the text was selected with a Range; a finger's long-press selection with handles cannot be made in headless Chromium");
    });

    await step("A2 draw and comment", async (n) => {
      await enterDraw(env, ws);
      drawn = await drawAround(env, ws, "#chart");
      assert.equal(drawn.after.scroll_y, drawn.before.scroll_y, "the page scrolled while drawing");
      drawing = await submitComposer(env, ws, id, "Is the last bar right?");
      const stored = await rootOf(env, id, drawing.id);
      assert.ok(stored.stroke, "the comment has no stroke");
      n.saw(`drawn with ${env.profile.touch ? "touch events" : "the mouse"} without the page scrolling; stored: ${await strokeAgrees(ws, stored.stroke, drawn)}`);
      await env.report.shot(ws.page, "A2-after-draw");
    });

    await step("A3 agent reads it back", async (n) => {
      const rest = (await restComments(env, id)).find((c) => c.id === drawing.id);
      const { threads } = await agent.call("artifact_comments", { id, op: "list" });
      const viaMcp = threads.find((t) => t.id === drawing.id);
      assert.deepEqual(viaMcp.stroke, rest.stroke, "REST and MCP disagree about the stroke");
      assert.equal(threads.find((t) => t.id === kept.id).quote, "finished on schedule");
      const els = rest.stroke.elements;
      assert.ok(els.length >= 1 && els.some((e) => e.path.includes("chart") || e.path.includes("bar")), `elements under the stroke: ${JSON.stringify(els)}`);
      n.saw(`REST and MCP return the same stroke (${rest.stroke.points.length} points); the quote is there; ${els.length} element(s) under the stroke, first ${els[0].path} ${els[0].tag}`);
    });

    await step("A3 agent gets the picture", async (n) => {
      const file = path.join(env.out, `annot-${env.profile.name}-note.png`);
      const r = await noteImage([env.base, id, drawing.id, "--out", file]);
      const png = await pngSize(r.path ?? file);
      assert.equal(png.width, r.width, "the PNG's width differs from what the command said");
      assert.equal(png.height, r.height, "the PNG's height differs from what the command said");
      assert.ok(png.width >= 40 && png.height >= 40, `a ${png.width}x${png.height} picture is too small to show anything`);
      assert.equal(r.anchor_found, true);
      n.saw(`${process.env.SHX_NOTE_IMAGE || "shx-note-image"} wrote ${r.path ?? file}: a ${png.width}x${png.height} PNG (${png.bytes} bytes), anchor_found true, version ${r.version}`);
      n.assumed("that the picture shows the stroke on the right spot is judged by fidelity's element check and by looking at it, not here");
    });

    await step("A4 page changes, check, status", async (n) => {
      const first = await status();
      assert.deepEqual(Object.values(first), ["current", "current", "current"]);
      await agent.call("update_artifact", { id, base_version: 1, content: richPage({ rev: 2 }), note: "reworded, chart removed" });
      const stale = await status();
      assert.deepEqual(Object.values(stale), ["unchecked", "unchecked", "unchecked"]);
      const checked = await noteImage(["check", env.base, id]);
      const after = await status();
      assert.equal(after[kept.id], "ok", "kept quote");
      assert.equal(after[reworded.id], "lost", "reworded quote");
      assert.equal(after[drawing.id], "lost", "removed element");
      const match = (await rootOf(env, id, reworded.id)).match;
      assert.equal(match.version, 2);
      assert.equal(match.found, false);
      n.saw(`after the edit all three were unchecked; after \`check\` (${JSON.stringify(checked).slice(0, 120)}): kept quote ok, reworded quote lost, removed chart lost`);
    });

    await step("A4 reply and resolve", async (n) => {
      await agent.call("artifact_comments", { id, op: "add", parent: reworded.id, body: "Reworded; the number is gone." });
      await agent.call("artifact_comments", { id, op: "resolve", comment_id: reworded.id });
      await agent.call("artifact_comments", { id, op: "resolve", comment_id: drawing.id });
      const all = await restComments(env, id);
      assert.equal(all.find((c) => c.id === reworded.id).resolved, true);
      assert.ok(all.some((c) => c.parent === reworded.id && c.author === "agent"));
      const { threads } = await agent.call("artifact_comments", { id, op: "list" });
      assert.deepEqual(threads.map((t) => t.id), [kept.id]);
      n.saw("the agent replied to one thread and resolved two; the open list now holds only the kept-quote thread");
    });

    await step("A5 wake", async (n) => {
      n.saw(`watch_artifacts woke ${woke.ms} ms after the first comment was sent from the phone (${woke.events.length} comments event(s))`);
    });
  } finally {
    await ws?.close();
    await agent.close();
  }
}
