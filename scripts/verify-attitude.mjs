import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE;
assert.ok(base, "Set BASE to the site URL.");
const out = process.env.ATTITUDE_SCREEN_DIR || "screenshots";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const errors = [];
  const requests = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => window.__SIDEREON_READY === true, undefined, { timeout: 30000 });
  page.on("request", (request) => requests.push(request.url()));
  await page.waitForFunction(() => getComputedStyle(document.getElementById("boot")).opacity === "0");

  const panel = page.locator("#attitude-panel");
  const select = page.locator("#attitude-satellite");
  const chart = page.locator("#attitude-chart");
  const overlay = page.locator("#overlay");
  const rows = overlay.locator("tbody tr");
  const expand = panel.getByRole("button", { name: "Expand GNSS attitude" });
  await panel.scrollIntoViewIfNeeded();
  await page.locator('#attitude-chart[data-satellite="G09"]').waitFor({ timeout: 60000 });
  assert.equal(await select.inputValue(), "G09");
  assert.match(await page.locator("#attitude-legend").innerText(), /Nominal yaw.*Sun elevation β.*Shadow/s);
  assert.ok(await chart.evaluate((canvas) => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, i) => i % 4 === 3 && value > 0);
  }));
  await panel.screenshot({ path: join(out, "attitude.png") });

  await expand.click();
  await overlay.waitFor({ state: "visible" });
  await overlay.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  assert.equal(await overlay.evaluate((element) => getComputedStyle(element).opacity), "1");
  const { backgroundColor, opacity } = await overlay.locator(".overlay-card").evaluate((card) => {
    const style = getComputedStyle(card);
    return { backgroundColor: style.backgroundColor, opacity: style.opacity };
  });
  assert.equal(opacity, "1");
  assert.match(backgroundColor, /^rgb\(/, `Expected an opaque dialog background, got ${backgroundColor}`);
  assert.equal(await rows.count(), 145);
  assert.equal(await rows.first().locator("td").first().innerText(), "00:00");
  assert.equal(await rows.last().locator("td").first().innerText(), "24:00");
  const shadow = rows.filter({ hasText: "Shadow" }).first();
  assert.deepEqual(await shadow.locator("td").allTextContents(), [
    "07:20", "835557669.184", "-114.4154", "-118.6304", "9.2852", "Shadow",
  ]);
  await overlay.screenshot({ path: join(out, "attitude-maximized.png") });

  await select.selectOption("G11");
  await overlay.locator('#attitude-chart[data-satellite="G11"]').waitFor({ timeout: 60000 });
  assert.deepEqual(await rows.first().locator("td").allTextContents(), [
    "00:00", "835531269.184", "26.7999", "26.7999", "-24.9257", "Nominal",
  ]);
  await page.keyboard.press("Escape");
  await overlay.waitFor({ state: "hidden" });
  assert.equal(await panel.locator("#attitude-satellite").inputValue(), "G11");
  assert.equal(await page.locator("#net-pill").innerText(), "NET 0");
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  console.log("GPS attitude verified for G09 and G11. NET 0.");
} finally {
  await browser.close();
}
