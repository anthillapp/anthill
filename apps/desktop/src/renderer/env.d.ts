/// <reference types="vite/client" />

import type { AnthillApi } from "../shared/ipc.js";

declare global {
  interface Window {
    /** Injected by the preload script. See `src/preload/index.ts`. */
    anthill: AnthillApi;
  }
}

export {};
