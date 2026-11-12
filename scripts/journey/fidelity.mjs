// c7: does the picture an agent gets show the stroke where the person drew it? Draw on a
// phone, then render the page the way the agent's command does, at the stroke's recorded
// viewport, and ask which element lies under the stroke's centre.
import assert from "node:assert/strict";
import path from "node:path";
import { mcpSession, noteImage, pngSize } from "./lib.mjs";
import { richPage } from "./fixtures.mjs";
import { drawAround, enterDraw, openWorkspace, rootOf, submitComposer } from "./ui.mjs";

export async function fidelity(env) {
  const { step } = env.report;
  const agent = await mcpSession(env.base);
  let id, ws;
  const strokes = [];
  // Draws around `selector`, saves the comment and keeps what the server stored.
  const draw = async (name, selector, text) => {
    const drawn = await drawAround(env, ws, selector);
    const comment = await submitComposer(env, ws, id, text);
    const stored = await rootOf(env, id, comment.id);
    assert.ok(stored.stroke, `${name}: no stroke stored`);
    strokes.push({ name, comment, stroke: stored.stroke, scrolled: drawn.before.scroll_y });
    return stored.stroke;
  };
  try {
    await step("0 publish", async (n) => {
      id = (await agent.call("create_artifact", { title: "Quarterly note", kind: "html", content: richPage({ rev: 1, filler: 3 }) })).id;
      ws = await openWorkspace(env, id);
      await enterDraw(env, ws);
      n.saw(`published ${id} (wrapped paragraphs, an SVG chart, a table) and turned draw on at ${env.profile.name}`);
    });

    await step("1 draw around a chart bar", async (n) => {
      const s = await draw("chart bar", "#bar-q2", "This bar.");
      n.saw(`stored anchor ${s.anchor}, ${s.points.length} points, viewport ${s.viewport.w}x${s.viewport.h}`);
    });

    await step("2 draw around a table cell with the page scrolled", async (n) => {
      const s = await draw("table cell", "#cell-south-q1", "This cell.");
      assert.ok(strokes[1].scrolled > 400, `only scrolled to ${strokes[1].scrolled}`);
      n.saw(`drawn at scrollY ${strokes[1].scrolled}; stored anchor ${s.anchor}, ${s.points.length} points`);
    });

    await step("3 re-render at the recorded viewport", async (n) => {
      for (const { name, stroke } of strokes) {
        // Rendered alone, the way the agent's command lays the page out: the viewport's
        // size is all it gets from the stroke.
        const ctx = await env.browser.newContext({ viewport: { width: stroke.viewport.w, height: stroke.viewport.h } });
        const page = env.report.track(await ctx.newPage());
        await page.goto(`${env.base}/preview/${id}?version=${stroke.version}`);
        const seen = await page.evaluate(async (stroke) => {
          const xs = stroke.points.map((p) => stroke.box.x + p[0]), ys = stroke.points.map((p) => stroke.box.y + p[1]);
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
          scrollTo(0, cy - innerHeight / 2);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const under = document.elementFromPoint(cx - scrollX, cy - scrollY);
          const anchor = document.querySelector(stroke.anchor);
          return { under: under?.tagName.toLowerCase() + (under?.id ? "#" + under.id : ""), anchor: !!anchor, same: under === anchor, inside: !!anchor?.contains(under), width: innerWidth };
        }, stroke);
        await ctx.close();
        assert.ok(seen.anchor, `${name}: the anchor ${stroke.anchor} finds nothing in the re-render`);
        assert.ok(seen.same || seen.inside, `${name}: under the stroke's centre is ${seen.under}, not the anchor ${stroke.anchor}`);
        n.saw(`${name}: at ${seen.width}px the element under the stroke's centre is ${seen.under}, ${seen.same ? "the anchor itself" : "inside the anchor"} ${stroke.anchor}`);
      }
    });

    await step("4 the agent's picture", async (n) => {
      for (const { name, comment } of strokes) {
        const file = path.join(env.out, `fidelity-${env.profile.name}-${name.replace(/\W+/g, "-")}.png`);
        const r = await noteImage([env.base, id, comment.id, "--out", file]);
        const png = await pngSize(r.path ?? file);
        assert.equal(r.anchor_found, true, `${name}: the command did not find the anchor`);
        assert.ok(png.width >= 40 && png.height >= 40, `${name}: ${png.width}x${png.height}`);
        n.saw(`${name}: crop ${r.path ?? file}, ${png.width}x${png.height}, anchor_found true`);
      }
      n.assumed("whether each crop shows the stroke on the right spot is for a person to look at the printed paths; the test checks the element, not the pixels");
    });
  } finally {
    await ws?.close();
    await agent.close();
  }
}
