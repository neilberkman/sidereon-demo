// Deterministic verification of the WebKit scroll-tug fix.
//
// The tug is caused by a NON-PASSIVE `wheel` listener on the scroll hit-test
// path (OrbitControls registers one with `{ passive: false }`), which forces
// WebKit off its fast off-main-thread scroll path. Synthetic Playwright wheel
// events bypass that input pipeline, so the feel can't be reproduced in-harness
// -- but the *cause* is a concrete, countable DOM fact: is a non-passive wheel
// listener attached to the globe canvas after boot?
//
// We monkeypatch add/removeEventListener BEFORE any page code runs, track every
// `wheel` registration with its passive flag and target, net out removals, and
// report how many non-passive wheel listeners remain on the #globe-host canvas.
// Expected: 0 (OrbitControls adds one; our fix removes it). ENGINE=webkit.
import { webkit, chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:4173";
const ENGINE = process.env.ENGINE || "webkit";
const browserType = ENGINE === "chromium" ? chromium : webkit;

const browser = await browserType.launch();
const page = await browser.newPage();

await page.addInitScript(() => {
  window.__wheelLog = [];          // chronological add/remove events
  window.__wheelSet = new Set();   // currently-attached non-passive wheel handlers
  const ael = EventTarget.prototype.addEventListener;
  const rel = EventTarget.prototype.removeEventListener;
  const describe = (t) => {
    if (t === window) return "window";
    if (t === document) return "document";
    const el = t;
    return (el.tagName ? el.tagName.toLowerCase() : "?") + (el.id ? "#" + el.id : "") +
      (el.parentElement && el.parentElement.id ? "(in #" + el.parentElement.id + ")" : "");
  };
  const isPassive = (opts) => opts === true ? false : (opts && typeof opts === "object" ? opts.passive === true : false);
  EventTarget.prototype.addEventListener = function (type, handler, opts) {
    if (type === "wheel") {
      const passive = isPassive(opts);
      window.__wheelLog.push({ op: "add", target: describe(this), passive });
      if (!passive) window.__wheelSet.add(handler);
    }
    return ael.call(this, type, handler, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, handler, opts) {
    if (type === "wheel") {
      window.__wheelLog.push({ op: "remove", target: describe(this) });
      window.__wheelSet.delete(handler);
    }
    return rel.call(this, type, handler, opts);
  };
});

await page.goto(BASE, { waitUntil: "load" });
await page.waitForFunction(() => window.__SIDEREON_READY === true, { timeout: 30000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => ({
  log: window.__wheelLog,
  nonPassiveRemaining: window.__wheelSet.size,
}));
out.engine = ENGINE;
console.log(JSON.stringify(out, null, 2));
await browser.close();
