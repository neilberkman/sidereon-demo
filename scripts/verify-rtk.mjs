// Verify the RTK panel through the built browser application and bundled WASM.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const browserErrors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));

try {
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.__SIDEREON_READY === true, { timeout: 30_000 });
  await page.locator("#rtk-panel").scrollIntoViewIfNeeded();
  await page.locator("#rtk-run").click();
  await page.locator("#rtk-status").filter({ hasText: /^FIXED$/ }).waitFor({ timeout: 120_000 });

  const status = (await page.locator("#rtk-status").textContent())?.trim();
  const errorText = (await page.locator("#rtk-error").textContent())?.trim() || "";
  const ratioText = (await page.locator("#rtk-ratio").textContent())?.trim() || "";
  const net = (await page.locator("#rtk-net-pill").textContent())?.trim();
  const fixed = errorText.match(/^([0-9.]+) (nm|µm|mm|m) fixed\b/);
  assert.ok(fixed, `could not parse fixed error: ${JSON.stringify(errorText)}`);
  const scaleM = { nm: 1e-9, "µm": 1e-6, mm: 1e-3, m: 1 }[fixed[2]];
  const fixedErrorM = Number(fixed[1]) * scaleM;

  assert.equal(status, "FIXED");
  assert.ok(Number.isFinite(fixedErrorM), `invalid fixed error: ${fixedErrorM}`);
  assert.ok(fixedErrorM < 0.006, `fixed error ${fixedErrorM} m is not below 6 mm`);
  assert.match(ratioText, /\bWL 8$/);
  assert.equal(net, "NET 0");
  assert.deepEqual(browserErrors, []);

  await page.locator("#rtk-panel").screenshot({ path: `${OUT}/rtk-fixed.png` });
  writeFileSync(
    `${OUT}/rtk-browser-evidence.json`,
    `${JSON.stringify({ status, errorText, fixedErrorM, ratioText, net, browserErrors }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ status, errorText, fixedErrorM, ratioText, net, browserErrors }));
} finally {
  await browser.close();
}
