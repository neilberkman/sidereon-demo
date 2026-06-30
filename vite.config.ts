import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Single source of truth for the on-screen version badge: read the ACTUAL
// installed @neilberkman/sidereon version at config time and expose it to the
// app. The badge then always equals the lib version the demo really consumes.
// Read the file directly (its package exports block subpath access).
const pkgPath = fileURLToPath(
  new URL("./node_modules/@neilberkman/sidereon/package.json", import.meta.url),
);
const sidereonVersion: string = JSON.parse(readFileSync(pkgPath, "utf8")).version;

export default defineConfig({
  // wasm-pack web output + explicit ?url wasm import; no extra plugins needed.
  server: { port: 5173 },
  build: { target: "esnext" },
  define: {
    __SIDEREON_VERSION__: JSON.stringify(sidereonVersion),
  },
});
