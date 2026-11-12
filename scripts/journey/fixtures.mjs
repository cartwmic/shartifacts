// The pages the journeys publish. Plain HTML with its own script, as an agent would write.

// A small form whose answers go to the artifact's shared documents, so a second viewer and
// the agent see them. `rev` shows in the heading so an update can be told from the first.
export const formPage = (rev) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Journey form</title>
<style>body{font:16px system-ui;margin:16px}textarea{width:100%;min-height:4em}fieldset{margin:12px 0}button{font-size:18px;padding:10px 16px}</style></head>
<body>
<h1 id="heading">Journey form v${rev}</h1>
<form id="f">
  <label>Comment<textarea id="comment" name="comment" required></textarea></label>
  <fieldset><legend>Pick one</legend>
    <label><input type="radio" name="pick" value="alpha"> Alpha</label>
    <label><input type="radio" name="pick" value="beta"> Beta</label>
    <label><input type="radio" name="pick" value="gamma"> Gamma</label>
  </fieldset>
  <fieldset><legend>Tick any</legend>
    <label><input type="checkbox" name="item" value="milk"> Milk</label>
    <label><input type="checkbox" name="item" value="bread"> Bread</label>
    <label><input type="checkbox" name="item" value="eggs"> Eggs</label>
  </fieldset>
  <button id="submit" type="submit">Submit</button>
  <p id="status" role="status"></p>
</form>
<h2>Entries</h2>
<ul id="entries"></ul>
<script>
(async () => {
  const status = document.getElementById("status"), list = document.getElementById("entries");
  const db = await claude.use("db");
  if (!db) { status.textContent = "db unavailable"; return; }
  const entries = db.collection("entries");
  entries.orderBy("at").onSnapshot((snap) => {
    list.replaceChildren(...snap.docs.map((d) => {
      const e = d.data(), li = document.createElement("li");
      li.textContent = [e.comment, e.pick, e.items.join("+")].join(" | ");
      return li;
    }));
  });
  document.getElementById("f").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    await entries.add({
      comment: f.comment.value,
      pick: f.pick.value,
      items: [...f.querySelectorAll("input[name=item]:checked")].map((i) => i.value),
      width: innerWidth,
      at: Date.now(),
    });
    f.reset();
    status.textContent = "saved";
  });
})();
</script></body></html>`;

// A page to comment on and draw over: wrapped paragraphs, an SVG chart and a table, and
// filler between them when the page must scroll. rev 2 is the "after" of a change: the
// kept paragraph stays, the reworded one says something else, the chart is gone.
export const richPage = ({ rev = 1, filler = 0 } = {}) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quarterly note</title>
<style>
body{font:17px/1.5 system-ui;margin:0;padding:16px}
p{margin:0 0 14px}
svg{display:block;width:100%;height:auto}
.fill{height:420px;border-top:1px solid #ddd;margin-top:18px;padding-top:12px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:8px;text-align:left}
</style></head>
<body>
<h1 id="title">Quarterly note</h1>
<p id="keep">The rollout finished on schedule and the costs stayed flat across every region we serve.</p>
<p id="reword">${rev === 1 ? "Support tickets dropped by a third after the launch, mostly from the setup questions." : "Support tickets fell sharply once the launch was done, mostly the setup questions."}</p>
<p id="long">This paragraph is long on purpose so that it wraps over several lines on a phone: the quarter began with a slow week, picked up through the spring, and ended with the strongest month we have had since the product shipped, which nobody had planned for.</p>
${rev === 1 ? `<figure id="chart" style="margin:0 0 14px"><svg viewBox="0 0 300 160" role="img" aria-label="Revenue by quarter">
  <rect id="bar-q1" x="20" y="90" width="50" height="60" fill="#4a7"/><rect id="bar-q2" x="90" y="50" width="50" height="100" fill="#47a"/>
  <rect id="bar-q3" x="160" y="70" width="50" height="80" fill="#a74"/><rect id="bar-q4" x="230" y="30" width="50" height="120" fill="#a47"/>
  <text x="20" y="158" font-size="10">Q1</text><text x="90" y="158" font-size="10">Q2</text><text x="160" y="158" font-size="10">Q3</text><text x="230" y="158" font-size="10">Q4</text></svg></figure>` : `<p id="chart-moved">The chart moved to the appendix.</p>`}
${Array.from({ length: filler }, (_, i) => `<section class="fill" id="fill-${i + 1}"><h2>Section ${i + 1}</h2><p>Filler so the page scrolls.</p></section>`).join("\n")}
<table id="sales"><thead><tr><th>Region</th><th>Q1</th><th>Q2</th></tr></thead>
<tbody><tr><td>North</td><td id="cell-north-q1">12</td><td id="cell-north-q2">15</td></tr>
<tr><td>South</td><td id="cell-south-q1">9</td><td id="cell-south-q2">11</td></tr></tbody></table>
<p style="margin-top:14px">End of the note.</p>
</body></html>`;
