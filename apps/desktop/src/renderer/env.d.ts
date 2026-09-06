/// <reference types="vite/client" />

import type { AnthillApi } from "../shared/ipc.js";

declare global {
  interface Window {
    /** Injected by the preload script. See `src/preload/index.ts`. */
    anthill: AnthillApi;
  }

  /**
   * The app's version, replaced at build time from `package.json`.
   *
   * A constant rather than a runtime read: the renderer has no filesystem, and
   * asking main for a string that cannot change during a session would be a
   * round trip to learn something the build already knew.
   */
  const __ANTHILL_VERSION__: string;
}

export {};
