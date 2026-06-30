// Verify the interactive SOLVE panel against a real preview build.
// Asserts, by driving the actual controls and reading the rendered values:
//   (a) the correction segmented control re-solves and shifts the fix + DOP
//   (b) the elevation-mask slider re-solves, dropping used sats and moving DOP
//   (c) zero console errors
//   (d) NET pill stays 0 after load (zero network after every re-solve)
//   (e) screenshots of the panel at a couple of settings
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:4173";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const fail = [];
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(BASE, { waitUntil: "load" });
await page.waitForFunction(() => window.__SIDEREON_READY === true, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.locator("#solve-panel").scrollIntoViewIfNeeded();
await page.waitForTimeout(400);

// ---- readers ----
const llh = () =>
  page.$$eval("#solve-llh .v", (els) => els.map((e) => e.textContent.trim()).join(" | "));
const used = () =>
  page.$eval("#solve-used", (e) => e.textContent.trim()).catch(() => "");
// metric -> { raw, active } from the RAW vs ACTIVE compare table
const metrics = () =>
  page.evaluate(() => {
    const out = {};
    document.querySelectorAll("#solve-compare .cmp-row:not(.cmp-head)").forEach((r) => {
      const k = r.querySelector(".k")?.textContent?.trim();
      const vs = [...r.querySelectorAll(".v")].map((v) => v.textContent.trim());
      if (k) out[k] = { raw: vs[0], active: vs[1] };
    });
    return out;
  });
const headline = () => page.$eval("#solve-headline", (e) => e.textContent.trim());

const setCorr = async (key) => {
  await page.click(`#solve-corr .seg-btn[data-corr="${key}"]`);
  await page.waitForTimeout(350);
};
const setMask = async (deg) => {
  await page.$eval(
    "#solve-mask",
    (el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    deg,
  );
  await page.waitForTimeout(350);
};

// ---- baseline: NONE, mask 0 ----
await setCorr("none");
await setMask(0);
const llh0 = await llh();
const m0 = await metrics();
const usedCount0 = Number(m0["SATS USED"].active);
console.log("baseline NONE mask0:", llh0, "| PDOP", m0.PDOP.active, "| used", usedCount0);
await page.locator("#solve-panel").screenshot({ path: `${OUT}/solve-none-mask0.png` });

// ---- (a) corrections: BOTH at mask 0 must move the position ----
await setCorr("both");
const llhBoth = await llh();
const mBoth = await metrics();
console.log("BOTH mask0:", llhBoth, "| PDOP", mBoth.PDOP.active, "| head:", await headline());
if (llhBoth === llh0) fail.push("corrections NONE->BOTH did not change the displayed LLH position");
if (mBoth["SATS USED"].active !== String(usedCount0))
  fail.push("corrections changed the used-sat count (should not at mask 0)");
await page.locator("#solve-panel").screenshot({ path: `${OUT}/solve-both-mask0.png` });

// also confirm IONO-only and TROPO-only each differ from raw and from each other
await setCorr("iono");
const llhIono = await llh();
await setCorr("tropo");
const llhTropo = await llh();
if (llhIono === llh0) fail.push("IONO-only did not move the fix from raw");
if (llhTropo === llh0) fail.push("TROPO-only did not move the fix from raw");
if (llhIono === llhTropo) fail.push("IONO-only and TROPO-only produced identical fixes");
console.log("IONO:", llhIono);
console.log("TROPO:", llhTropo);

// ---- (b) elevation mask: sweep, must drop used sats and move DOP ----
await setCorr("none");
await setMask(0);
const sweep = [];
for (const deg of [0, 10, 20, 35, 45]) {
  await setMask(deg);
  const m = await metrics();
  sweep.push({
    deg,
    used: Number(m["SATS USED"].active),
    pdop: Number(m.PDOP.active),
    hdopVdop: m["HDOP / VDOP"].active,
    usedText: await used(),
  });
}
console.table(sweep);

const baseUsed = sweep[0].used;
const maxMask = sweep[sweep.length - 1];
if (!(maxMask.used < baseUsed))
  fail.push(`mask 45 did not reduce used sats: ${baseUsed} -> ${maxMask.used}`);
if (maxMask.pdop === sweep[0].pdop)
  fail.push(`mask 45 did not change PDOP: ${sweep[0].pdop} -> ${maxMask.pdop}`);
// geometry degrades as the mask climbs: used count is non-increasing and ends
// lower, PDOP is non-decreasing and ends higher
for (let i = 1; i < sweep.length; i++) {
  if (sweep[i].used > sweep[i - 1].used)
    fail.push(`used sats went UP with a higher mask: ${JSON.stringify(sweep[i - 1])} -> ${JSON.stringify(sweep[i])}`);
  if (sweep[i].pdop < sweep[i - 1].pdop - 1e-9)
    fail.push(`PDOP improved with a higher mask: ${sweep[i - 1].pdop} -> ${sweep[i].pdop}`);
}
if (!(maxMask.pdop > sweep[0].pdop))
  fail.push(`PDOP did not degrade across the sweep: ${sweep[0].pdop} -> ${maxMask.pdop}`);

// pick the first mask that actually drops a satellite for the screenshot
const dropAt = sweep.find((s) => s.used < baseUsed);
if (dropAt) {
  await setMask(dropAt.deg);
  await page.locator("#solve-panel").screenshot({ path: `${OUT}/solve-mask-${dropAt.deg}.png` });
  console.log(`first satellite drop at mask ${dropAt.deg}°: ${baseUsed} -> ${dropAt.used}`);
} else {
  fail.push("no mask value in 0..30 dropped any satellite");
}

// ---- combined: BOTH + a biting mask, full panel + overlay screenshot ----
await setCorr("both");
await setMask(dropAt ? dropAt.deg : 15);
await page.locator("#solve-panel").screenshot({ path: `${OUT}/solve-both-masked.png` });
await page.click('.maximize[data-panel="solve"]');
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/solve-overlay-both-masked.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// ---- (d) NET pill 0 after all those re-solves ----
const net = (await page.$eval("#net-pill", (e) => e.textContent.trim())) || "";
if (net !== "NET 0") fail.push(`net-pill = ${JSON.stringify(net)} (expected "NET 0")`);

await browser.close();
if (errors.length) fail.push(`${errors.length} console error(s)`);

console.log("\n=== NET pill:", JSON.stringify(net));
console.log("=== console errors:", errors.length);
for (const e of errors) console.log("   !", e);
console.log("=== FAILURES:", fail.length);
for (const f of fail) console.log("   ✗", f);
process.exit(fail.length ? 1 : 0);
