import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";

test("bundled WTZR/WTZZ assets produce a usable, accurate RTK solution", async () => {
  const files = new Map([
    ["/data/rtk/GBM0MGXRAP_20201770000_01D_05M_ORB_24epoch.sp3", "GBM0MGXRAP_20201770000_01D_05M_ORB_24epoch.sp3"],
    ["/data/rtk/WTZR00DEU_R_20201770000_01D_30S_MO_40epoch.rnx", "WTZR00DEU_R_20201770000_01D_30S_MO_40epoch.rnx"],
    ["/data/rtk/WTZZ00DEU_R_20201770000_01D_30S_MO_40epoch.rnx", "WTZZ00DEU_R_20201770000_01D_30S_MO_40epoch.rnx"],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const filename = files.get(path);
    if (!filename) return new Response("not found", { status: 404 });
    const bytes = readFileSync(join(process.cwd(), "public/data/rtk", filename));
    return new Response(new Uint8Array(bytes));
  };

  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" });
  try {
    const engine = await vite.ssrLoadModule("/src/engine.ts");
    const assets = await engine.loadRtkAssets();
    const result = engine.solveRtkDemo(assets);

    assert.equal(assets.provenance.sp3File, "GBM0MGXRAP_20201770000_01D_05M_ORB_24epoch.sp3");
    assert.equal(result.epochs, 40);
    assert.equal(result.sp3Epochs, 24);
    assert.equal(result.baseStation, "WTZR");
    assert.equal(result.roverStation, "WTZZ00DEU");
    assert.equal(result.fixedStatus, "Fixed");
    assert.equal(result.wideLaneCount, 8);
    assert.ok(result.floatErrorM < 0.03, `float error ${result.floatErrorM} m`);
    assert.ok(result.fixedErrorM < 0.006, `fixed error ${result.fixedErrorM} m`);
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
  }
});
