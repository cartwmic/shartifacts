// Steps 1-10 of the base journey: an agent publishes a page with a form, a person on a phone (or a
// desktop) fills it in a real browser, and the agent reads the answers back.
import assert from "node:assert/strict";
import { mcpSession, watch, sizeOf } from "./lib.mjs";
import { formPage } from "./fixtures.mjs";
import { expect, tap, routed } from "./ui.mjs";

// The source of the one revision a get_artifact call returns.
const latest = (artifact) => artifact.revisions.at(-1).content;

export async function base(env) {
  const { step } = env.report;
  const agent = await mcpSession(env.base);
  let id, page, ctx, form;
  const entry = { comment: `Looks good on ${env.profile.name}`, pick: "beta", items: ["bread", "eggs"] };
  // The page's own script saves the form; this fills it in as a person does and presses
  // Submit with a finger on a phone, a mouse on a desktop.
  const fill = async (text, before) => {
    await form.locator("#comment").fill(text);
    await tap(env, form.locator("input[name=pick][value=beta]"));
    for (const item of entry.items) await tap(env, form.locator(`input[name=item][value=${item}]`));
    await form.locator("#status").evaluate((el) => (el.textContent = ""));
    before?.();
    await tap(env, form.locator("#submit"));
    await expect(form.locator("#status")).toHaveText("saved");
  };
  try {
    await step("1 publish", async (n) => {
      const r = await agent.call("create_artifact", { title: "Journey form", kind: "html", content: formPage(1), description: "base journey", tags: ["journey"] });
      id = r.id;
      assert.equal(r.version, 1);
      assert.deepEqual(r.warnings ?? [], []);
      n.saw(`create_artifact made ${id} at version ${r.version}, warnings none`);
    });

    await step("2 update in place", async (n) => {
      const r = await agent.call("update_artifact", { id, base_version: 1, content: formPage(2), note: "second version" });
      assert.equal(r.version, 2);
      const served = await (await fetch(`${env.base}/preview/${id}`)).text();
      assert.match(served, /Journey form v2/);
      assert.doesNotMatch(served, /Journey form v1/);
      n.saw(`update_artifact made version ${r.version}; the same URL /preview/${id} now serves "Journey form v2"`);
    });

    await step("3 list", async (n) => {
      const { artifacts } = await agent.call("list_artifacts", {});
      const mine = artifacts.find((a) => a.id === id);
      assert.ok(mine, "the artifact is not in the library");
      assert.equal(mine.version, 2);
      n.saw(`list_artifacts shows ${id} "${mine.title}" at version ${mine.version}`);
    });

    await step("4 read back the source", async (n) => {
      const source = latest(await agent.call("get_artifact", { id }));
      assert.ok(source === formPage(2), "the source read back is not what was published");
      n.saw(`get_artifact returns the v2 source byte for byte (${source.length} chars)`);
    });

    await step("5 browser fills the form", async (n) => {
      ctx = await env.browser.newContext(env.profile.context);
      page = env.report.track(await ctx.newPage());
      await page.goto(`${env.base}/view/${id}`);
      form = page.frameLocator("#preview");
      await expect(form.locator("#heading")).toHaveText("Journey form v2");
      await routed(page);
      await form.locator("body").evaluate(() => {
        window.__pointers = [];
        addEventListener("pointerdown", (e) => window.__pointers.push(e.pointerType), true);
      });
      await fill(entry.comment);
      const seen = await form.locator("body").evaluate(() => ({ pointers: window.__pointers, width: innerWidth, coarse: matchMedia("(pointer: coarse)").matches }));
      const want = env.profile.touch ? "touch" : "mouse";
      assert.ok(seen.pointers.length >= 1 && seen.pointers.every((t) => t === want), `the page saw pointers ${JSON.stringify(seen.pointers)}, expected only ${want}`);
      await env.report.shot(page, "5-submitted");
      n.saw(`${env.profile.name}: the page saw ${seen.pointers.length} ${want} presses, a ${seen.width}px wide frame, coarse pointer ${seen.coarse}; its own script reported "saved"`);
      if (env.profile.touch) n.assumed("typing into the comment box is fill(), not a phone keyboard; the presses are real touch events");
    });

    await step("6 agent reads the input", async (n) => {
      const { docs } = await agent.call("artifact_db", { id, op: "list", collection: "entries" });
      assert.equal(docs.length, 1, JSON.stringify(docs));
      const d = docs[0].data;
      assert.equal(d.comment, entry.comment);
      assert.equal(d.pick, entry.pick);
      assert.deepEqual(d.items.sort(), entry.items);
      n.saw(`artifact_db list entries -> comment "${d.comment}", pick ${d.pick}, items ${d.items.join("+")}, written from a ${d.width}px frame`);
    });

    await step("7 second session sees it", async (n) => {
      const other = await env.browser.newContext(env.profile.context);
      const p = env.report.track(await other.newPage());
      await p.goto(`${env.base}/view/${id}`);
      await expect(p.frameLocator("#preview").locator("#entries li")).toHaveText(`${entry.comment} | ${entry.pick} | ${entry.items.join("+")}`);
      await env.report.shot(p, "7-second-session");
      await other.close();
      n.saw("a second browser session with its own storage listed the entry the first one saved");
    });

    await step("8 versions", async (n) => {
      const r3 = await agent.call("update_artifact", { id, base_version: 2, content: formPage(3), note: "third version" });
      assert.equal(r3.version, 3);
      const history = await agent.call("get_artifact", { id, history: true });
      assert.equal(history.revisions.length, 3);
      const v1 = latest(await agent.call("get_artifact", { id, version: 1 }));
      assert.match(v1, /Journey form v1/);
      const restored = await agent.call("update_artifact", { id, base_version: 3, content: v1, note: "restore v1" });
      assert.equal(restored.version, 4);
      assert.ok(latest(await agent.call("get_artifact", { id })) === formPage(1), "the restored source differs from v1");
      const { docs } = await agent.call("artifact_db", { id, op: "list", collection: "entries" });
      assert.equal(docs.length, 1, "the person's input did not survive the updates");
      n.saw("history lists 3 versions, v1 reads back, restoring v1 made v4 with the v1 source, and the person's entry survived all of it");
    });

    await step("9 wake on input", async (n) => {
      // The page follows the latest version, so after the restore it reloads within a few
      // seconds. Fill the form only once it shows the restored source and takes input.
      await expect(form.locator("#heading")).toHaveText("Journey form v1");
      await routed(page);
      const wake = await watch(env.base, id, "db");
      await fill("A second answer", wake.mark);
      const { ms, events } = await wake.woken();
      n.saw(`watch_artifacts woke ${ms} ms after Submit with ${events.length} db event(s): ${events.map((e) => e.detail).join(", ")}`);
    });

    await step("10 resource", async (n) => {
      if (env.local) {
        n.saw(`server RSS ${(env.local.rssKB() / 1024).toFixed(1)} MB (all journeys sharing it), binary ${(await sizeOf(env.local.binary) / 1048576).toFixed(1)} MB, built in ${env.local.built} ms`);
        n.assumed("image size and storage on NFS were not measured: this runs a binary, not the image, on a local disk");
      } else n.assumed("RSS and image size need the server's host or its image; --base only reaches it over HTTP");
    });
  } finally {
    await ctx?.close();
    await agent.close();
  }
}
