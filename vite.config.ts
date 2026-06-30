import { defineConfig } from "vite";
export default defineConfig({
  // wasm-pack web output + explicit ?url wasm import; no extra plugins needed.
  server: { port: 5173 },
  build: { target: "esnext" },
});
