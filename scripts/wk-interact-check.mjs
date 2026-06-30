// WebKit interaction regression check for the scroll-tug fix:
//  (a) wheel over the hero globe scrolls the PAGE (never zooms) -- the fix must
//      not have broken the "wheel = scroll" contract.
//  (b) drag over the hero globe ORBITS the camera and does NOT scroll the page
//      (drag-to-orbit still works; pointer-event path untouched).
import { webkit, chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:4173";
const ENGINE = process.env.ENGINE || "webkit";
const bt = ENGINE === "chromium" ? chromium : webkit;
const fail = [];
const errors = [];
const browser = await bt.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto(BASE, { waitUntil: "load" });
await page.waitForFunction(() => window.__SIDEREON_READY === true, { timeout: 30000 });
await page.waitForTimeout(1500);

// (a) wheel over the hero globe scrolls the page
const frame = await page.locator(".hero-stage-frame").boundingBox();
await page.evaluate(() => window.scrollTo(0, 0));
await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
const y0 = await page.evaluate(() => window.scrollY);
await page.mouse.wheel(0, 500);
await page.waitForTimeout(400);
const y1 = await page.evaluate(() => window.scrollY);
if (!(y1 > y0)) fail.push(`wheel over hero globe did not scroll page: ${y0} -> ${y1}`);
console.log(`wheel scrolls page: ${y0} -> ${y1}`);

// (b) drag over the hero globe orbits the camera (autorotate paused during drag)
// and must NOT scroll the page. Detect orbit by sampling a stable pixel on the
// globe disc before/after a drag with autorotate frozen at drag time.
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(400);
const sBefore = await page.evaluate(() => window.scrollY);
const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
const before = await page.screenshot({ clip: { x: cx - 60, y: cy - 60, width: 120, height: 120 } });
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 12; i++) { await page.mouse.move(cx + i * 12, cy + i * 4); await page.waitForTimeout(8); }
await page.mouse.up();
const sAfter = await page.evaluate(() => window.scrollY);
const after = await page.screenshot({ clip: { x: cx - 60, y: cy - 60, width: 120, height: 120 } });
const changed = Buffer.compare(before, after) !== 0;
if (sAfter !== sBefore) fail.push(`drag over globe scrolled the page: ${sBefore} -> ${sAfter}`);
if (!changed) fail.push(`drag over globe did not change the rendered scene (orbit may be broken)`);
console.log(`drag: page scrollY ${sBefore} -> ${sAfter} (want equal); scene changed: ${changed}`);

if (errors.length) fail.push(`${errors.length} console error(s): ${errors.join(" | ")}`);
console.log("=== ENGINE:", ENGINE, "FAILURES:", fail.length);
for (const f of fail) console.log("   x", f);
await browser.close();
process.exit(fail.length ? 1 : 0);
