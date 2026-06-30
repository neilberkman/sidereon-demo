// Verify the shared globe is framed into the LEFT live-stage box (centered +
// filling), tracks scroll, and that nothing regressed:
//   - screenshots the Live section at 1600 and 900 + the live-stage crop
//   - asserts a click in the LEFT pane changes the observer coords
//   - asserts NET pill reads 0 and zero console errors
//   - REGRESSION: wheel over the globe scrolls the PAGE (never zooms)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:4173";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const fail = [];
const errors = [];
const browser = await chromium.launch();

async function ready(page) {
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.__SIDEREON_READY === true, { timeout: 30000 });
  await page.waitForTimeout(1800);
}

function centerLive(page) {
  return page.evaluate(() => {
    const el = document.getElementById("observer-pair");
    const r = el.getBoundingClientRect();
    window.scrollBy(0, r.top - (window.innerHeight - r.height) / 2);
  });
}

for (const W of [1600, 900]) {
  const page = await browser.newPage({ viewport: { width: W, height: 1000 }, reducedMotion: "reduce" });
  page.on("console", (m) => m.type() === "error" && errors.push(`[${W}] ` + m.text()));
  page.on("pageerror", (e) => errors.push(`[${W}] pageerror: ` + e.message));
  await ready(page);
  await page.locator("#observer-pair").scrollIntoViewIfNeeded();
  await centerLive(page);
  await page.waitForTimeout(1200);

  await page.screenshot({ path: `${OUT}/frame-live-${W}-full.png` });
  await page.locator("#observer-pair").screenshot({ path: `${OUT}/frame-live-${W}.png` });
  await page.locator("#live-stage").screenshot({ path: `${OUT}/frame-livestage-${W}.png` });
  console.log(`shot frame-live-${W}`);

  if (W === 1600) {
    // CLICK-TO-SET-OBSERVER in the LEFT pane must move the observer.
    const before = (await page.locator("#live-obs-coords").textContent())?.trim();
    const f = await page.locator("#live-stage .live-stage-frame").boundingBox();
    // click a touch left+down of center -> lands on the globe disc, not dead-center
    await page.mouse.click(f.x + f.width * 0.5, f.y + f.height * 0.56);
    await page.waitForTimeout(700);
    const after = (await page.locator("#live-obs-coords").textContent())?.trim();
    if (!after || after === before || /CLICK THE GLOBE/i.test(after)) {
      fail.push(`left-pane click did not move observer: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }
    console.log(`observer click: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

    // NET pills
    const netLive = (await page.locator("#live-net-pill").textContent())?.trim();
    const netSolve = (await page.locator("#net-pill").textContent())?.trim();
    if (netLive !== "NET 0") fail.push(`live-net-pill = ${JSON.stringify(netLive)}`);
    if (netSolve !== "NET 0") fail.push(`net-pill = ${JSON.stringify(netSolve)}`);

    // REGRESSION: wheel over the live globe scrolls the page.
    await page.locator("#observer-pair").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const sBefore = await page.evaluate(() => window.scrollY);
    const ls = await page.locator("#live-stage .live-stage-frame").boundingBox();
    await page.mouse.move(ls.x + ls.width / 2, ls.y + ls.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(500);
    const sAfter = await page.evaluate(() => window.scrollY);
    if (!(sAfter < sBefore)) fail.push(`wheel over live globe did not scroll page: ${sBefore} -> ${sAfter}`);
    console.log(`live wheel-scroll regression: ${sBefore} -> ${sAfter}`);

    // hero globe still frames into its stage
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/frame-hero-${W}.png` });
  }
  await page.close();
}

await browser.close();
if (errors.length) fail.push(`${errors.length} console error(s)`);
console.log("\n=== console errors:", errors.length);
for (const e of errors) console.log("   !", e);
console.log("=== FAILURES:", fail.length);
for (const f of fail) console.log("   x", f);
process.exit(fail.length ? 1 : 0);
