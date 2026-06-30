/// <reference types="vite/client" />

declare module "*?url" {
  const url: string;
  export default url;
}

// Injected by vite.config.ts: the actual installed @neilberkman/sidereon version.
declare const __SIDEREON_VERSION__: string;
