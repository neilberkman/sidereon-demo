import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:4188";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(BASE, { waitUntil: "load" });
// wait for the engine to finish booting and the first solve to land
await page.waitForFunction(() => window.__SIDEREON_READY === true, { timeout: 30000 });
await page.waitForTimeout(1500);

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
};

// 1 · hero
await shot("01-hero");

// 2 · language interfaces (default = Rust / propagate)
await page.locator("#interfaces").scrollIntoViewIfNeeded();
await page.waitForTimeout(700);
await shot("02-interfaces-rust");

// switch to Elixir + SP3/SPP to prove the polyglot story
await page.locator('#if-lang-tabs .lang-pill[data-lang="elixir"]').click();
await page.locator('#if-cap-tabs .cap-pill[data-cap="spp"]').click();
await page.waitForTimeout(400);
await shot("03-interfaces-elixir-spp");

// 3 · capabilities
await page.locator("#capabilities").scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await shot("04-capabilities");

// 4 · validation
await page.locator("#validation").scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await shot("05-validation");

// 5 · live demo section
await page.locator("#live").scrollIntoViewIfNeeded();
await page.waitForTimeout(1200);
await shot("06-live");

// read the net pill text
const netPill = await page.locator("#net-pill").textContent();
const solveHeadline = await page.locator("#solve-headline").textContent();

// 6 · skyplot expanded to fullscreen (with the az/el/range calc table)
await page.locator('.maximize[data-panel="sky"]').click();
await page.waitForTimeout(800);
await shot("07-skyplot-fullscreen");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// also capture the solve fullscreen (raw-vs-corrected + DOP + residuals + provenance)
await page.locator('.maximize[data-panel="solve"]').click();
await page.waitForTimeout(600);
await shot("08-solve-fullscreen");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// 7 · narrow viewport 760x900
const narrow = await browser.newPage({ viewport: { width: 760, height: 900 } });
narrow.on("console", (m) => {
  if (m.type() === "error") errors.push("[narrow] " + m.text());
});
narrow.on("pageerror", (e) => errors.push("[narrow] pageerror: " + e.message));
await narrow.goto(BASE, { waitUntil: "load" });
await narrow.waitForFunction(() => window.__SIDEREON_READY === true, { timeout: 30000 });
await narrow.waitForTimeout(1500);
await narrow.screenshot({ path: `${OUT}/09-narrow-hero.png` });
console.log("shot 09-narrow-hero");
await narrow.locator("#interfaces").scrollIntoViewIfNeeded();
await narrow.waitForTimeout(600);
await narrow.screenshot({ path: `${OUT}/10-narrow-interfaces.png` });
console.log("shot 10-narrow-interfaces");

await browser.close();

console.log("\n=== NET PILL: ", JSON.stringify(netPill));
console.log("=== SOLVE HEADLINE: ", JSON.stringify(solveHeadline?.replace(/\s+/g, " ").trim()));
console.log("=== CONSOLE ERRORS:", errors.length);
for (const e of errors) console.log("   !", e);
process.exit(errors.length ? 2 : 0);
