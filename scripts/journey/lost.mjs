// c3: after a page changes, a comment's status is `unchecked` until something renders the
// new version and reports. The person's browser reports it when the page is opened; the
// agent-side `check` command reports it too, and both must say the same.
import assert from "node:assert/strict";
import { mcpSession, noteImage } from "./lib.mjs";
import { richPage } from "./fixtures.mjs";
import { SEL, commentOnText, drawAround, enterDraw, expect, openWorkspace, restComments, rootOf, showThreads, submitComposer } from "./ui.mjs";

export async function lost(env) {
  const { step } = env.report;
  const agent = await mcpSession(env.base);
  let id, kept, reworded, drawing, slot, verdict;
  const statuses = async () => Object.fromEntries((await restComments(env, id)).filter((c) => !c.parent).map((c) => [c.id, c.status]));
  const named = (s) => `kept ${s[kept.id]}, reworded ${s[reworded.id]}, drawing ${s[drawing.id]}, slot ${s[slot.id]}`;
  try {
    await step("1 comment on a quote and a drawing", async (n) => {
      id = (await agent.call("create_artifact", { title: "Quarterly note", kind: "html", content: richPage({ rev: 1 }) })).id;
      const ws = await openWorkspace(env, id);
      kept = await commentOnText(env, ws, id, "#keep", "finished on schedule", "Keep this one.");
      reworded = await commentOnText(env, ws, id, "#reword", "dropped by a third", "This will be reworded.");
      await enterDraw(env, ws);
      await drawAround(env, ws, "#chart");
      drawing = await submitComposer(env, ws, id, "This drawing's chart will go.");
      // A paragraph with no id: its anchor is a slot like `p:nth-of-type(4)`, and in v2 another paragraph moves into it.
      await drawAround(env, ws, "p:nth-of-type(4)");
      slot = await submitComposer(env, ws, id, "This drawing's paragraph will go, and another one takes its place.");
      assert.match((await rootOf(env, id, slot.id)).stroke.anchor, /nth-of-type/, "the anchor of this drawing is a position");
      assert.deepEqual(Object.values(await statuses()), ["current", "current", "current", "current"]);
      await ws.close();
      n.saw("four comments on v1 (two quotes, two drawings, one of them on a paragraph with no id), all `current`");
    });

    await step("2 v2 is unchecked until someone looks", async (n) => {
      const r = await agent.call("update_artifact", { id, base_version: 1, content: richPage({ rev: 2 }), note: "v2: one quote kept, one reworded, chart and one paragraph removed" });
      assert.equal(r.version, 2);
      const s = await statuses();
      assert.deepEqual(Object.values(s), ["unchecked", "unchecked", "unchecked", "unchecked"]);
      assert.ok((await restComments(env, id)).every((c) => c.parent || !c.match || c.match.version < 2), "a report for v2 exists before anyone opened it");
      n.saw("published v2; before any check the API says unchecked for all four, with no report for v2");
    });

    await step("3 the browser reports", async (n) => {
      const ws = await openWorkspace(env, id);
      await expect.poll(async () => Object.values(await statuses()).includes("unchecked"), { message: "the page never reported" }).toBe(false);
      const s = await statuses();
      assert.equal(s[kept.id], "ok", "kept quote");
      assert.equal(s[reworded.id], "lost", "reworded quote");
      assert.equal(s[drawing.id], "lost", "drawing of a removed element");
      assert.equal(s[slot.id], "lost", "drawing of a paragraph that was removed while another moved into its place");
      verdict = named(s);
      await showThreads(env, ws, kept.id);
      await expect(ws.page.locator(SEL.thread(reworded.id)).locator(SEL.threadLost)).toBeVisible();
      await expect(ws.page.locator(SEL.thread(drawing.id)).locator(SEL.threadLost)).toBeVisible();
      await expect(ws.page.locator(SEL.thread(slot.id)).locator(SEL.threadLost)).toBeVisible();
      await expect(ws.page.locator(SEL.thread(kept.id)).locator(SEL.threadLost)).toBeHidden();
      await env.report.shot(ws.page, "3-browser-reported");
      await ws.close();
      n.saw(`opening v2 in the browser made the page report: ${verdict}; the panel flags the three lost threads as not found in this version`);
    });

    await step("4 the agent-side check agrees", async (n) => {
      // A third version with the same content as v2 puts every status back to unchecked.
      const r = await agent.call("update_artifact", { id, base_version: 2, content: richPage({ rev: 2 }), note: "v3, the same as v2" });
      assert.equal(r.version, 3);
      assert.deepEqual(Object.values(await statuses()), ["unchecked", "unchecked", "unchecked", "unchecked"]);
      await noteImage(["check", env.base, id]);
      const s = await statuses();
      assert.equal(named(s), verdict, "the check command disagrees with the browser");
      const match = (await restComments(env, id)).find((c) => c.id === reworded.id).match;
      assert.equal(match.version, 3);
      n.saw(`v3 reset the statuses to unchecked; \`shx-note-image check\` then gave the same verdict as the browser: ${named(s)}`);
    });
  } finally {
    await agent.close();
  }
}
