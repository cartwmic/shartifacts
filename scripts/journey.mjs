// Journeys: a person and an agent use a running shartifacts end to end, in a real browser.
//
//   node scripts/journey.mjs (--local | --base URL) [--out DIR] <name>...
//
// --local builds the binary and starts it on a random port with a temp data directory;
// --base uses a server that is already running. Names: base, annot, draw, lost, fidelity.
// annot, lost and fidelity call the dotfiles shx-note-image command: SHX_NOTE_IMAGE is its
// path (default shx-note-image on the PATH). Every step prints `SAW` (observed) or
// `ASSUMED` (not observed, and why); a failed step stops its journey, leaves evidence, and
// makes the exit code non-zero. Independent journeys run at the same time.
import { chromium } from "@playwright/test";
import { DESKTOP, PHONE, outputDir, reporter, startLocal } from "./journey/lib.mjs";

// What each journey runs as: the profiles it needs (each is a run of its own).
const JOURNEYS = {
  base: [PHONE, DESKTOP],
  annot: [PHONE, DESKTOP],
  draw: [PHONE, DESKTOP],
  lost: [PHONE, DESKTOP],
  fidelity: [PHONE, DESKTOP],
};

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const names = args.filter((a, i) => !a.startsWith("--") && !["--base", "--out"].includes(args[i - 1]));
if ((!args.includes("--local") && !flag("--base")) || !names.length || names.some((n) => !JOURNEYS[n])) {
  console.error("usage: node scripts/journey.mjs (--local | --base URL) [--out DIR] <name>...\nnames: " + Object.keys(JOURNEYS).join(", "));
  process.exit(2);
}

const t0 = performance.now();
const out = await outputDir(flag("--out"));
console.log(`screenshots and evidence: ${out}`);
const local = args.includes("--local") ? await startLocal() : null;
const base = local ? local.base : flag("--base").replace(/\/$/, "");
console.log(`server: ${base}${local ? ` (built in ${local.built} ms)` : ""}`);
let browser, results, serverLog;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const runs = names.flatMap((name) => JOURNEYS[name].map((profile) => ({ name, profile })));
  results = await Promise.all(
    runs.map(async ({ name, profile }) => {
      const report = reporter(`${name}@${profile.name}`, out);
      const { [name]: journey } = await import(`./journey/${name}.mjs`);
      const failure = await journey({ base, browser, local, out, profile, report }).then(() => null, (e) => e);
      report.say(`${failure ? "FAILED" : "PASSED"} in ${report.totalMs()} ms; steps: ${report.timings().map(([n, ms]) => `${n} ${ms}`).join(", ")}`);
      return { label: `${name}@${profile.name}`, failure, ms: report.totalMs() };
    }),
  );
} finally {
  await browser?.close();
  serverLog = local?.stderr();
  await local?.stop();
}
const failed = results.filter((r) => r.failure);
console.log(`\n${results.map((r) => `${r.failure ? "FAIL" : "ok  "} ${r.label} ${r.ms} ms`).join("\n")}\ntotal ${Math.round(performance.now() - t0)} ms (journeys ran together)`);
if (failed.length) {
  if (serverLog) console.log(`server stderr (last lines):\n${serverLog}`);
  process.exit(1);
}
