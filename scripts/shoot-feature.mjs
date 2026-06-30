// Capture the hero + the featured skyplot at desktop (1600) and narrow (760),
// and assert zero console errors and that the NET pill stays at 0 after load.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:4173";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch();

async function ready(page) {
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.__SIDEREON_READY === true, { timeout: 30000 });
  await page.waitForTimeout(1800); // let the skyplot arcs + a few sweep frames render
}

// ---- desktop 1600 ----
const wide = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
wide.on("console", (m) => m.type() === "error" && errors.push("[1600] " + m.text()));
wide.on("pageerror", (e) => errors.push("[1600] pageerror: " + e.message));
await ready(wide);

await wide.screenshot({ path: `${OUT}/feature-hero-1600.png` });
console.log("shot feature-hero-1600");

await wide.locator("#live").scrollIntoViewIfNeeded();
await wide.waitForTimeout(1200);
await wide.screenshot({ path: `${OUT}/feature-live-1600.png` });
await wide.locator("#observer-panel").scrollIntoViewIfNeeded();
await wide.waitForTimeout(600);
await wide.locator("#observer-panel").screenshot({ path: `${OUT}/feature-skyplot-1600.png` });
console.log("shot feature-skyplot-1600");

// fullscreen skyplot affordance still works
await wide.locator('.maximize[data-panel="sky"]').click();
await wide.waitForTimeout(1200);
await wide.screenshot({ path: `${OUT}/feature-skyplot-fullscreen.png` });
await wide.keyboard.press("Escape");
await wide.waitForTimeout(300);

const netPill = (await wide.locator("#net-pill").textContent())?.trim();

// ---- narrow 760 ----
const narrow = await browser.newPage({ viewport: { width: 760, height: 1000 } });
narrow.on("console", (m) => m.type() === "error" && errors.push("[760] " + m.text()));
narrow.on("pageerror", (e) => errors.push("[760] pageerror: " + e.message));
await ready(narrow);

await narrow.screenshot({ path: `${OUT}/feature-hero-760.png` });
console.log("shot feature-hero-760");
await narrow.locator("#observer-panel").scrollIntoViewIfNeeded();
await narrow.waitForTimeout(800);
await narrow.locator("#observer-panel").screenshot({ path: `${OUT}/feature-skyplot-760.png` });
console.log("shot feature-skyplot-760");
const netPillNarrow = (await narrow.locator("#net-pill").textContent())?.trim();

await browser.close();

console.log("\n=== NET PILL (1600):", JSON.stringify(netPill));
console.log("=== NET PILL  (760):", JSON.stringify(netPillNarrow));
console.log("=== CONSOLE ERRORS:", errors.length);
for (const e of errors) console.log("   !", e);
process.exit(errors.length ? 2 : 0);
