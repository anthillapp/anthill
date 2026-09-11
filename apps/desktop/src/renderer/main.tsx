import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// React Flow ships its own stylesheet; `@anthill/builder` deliberately does not
// import it so the library stays bundler-agnostic. The app entry must.
import "@xyflow/react/dist/style.css";
import "./styles.css";

import { Root } from "./Root.js";

/**
 * Under the desktop, the preload has already injected `window.anthill` before
 * this runs, so the bridge is a no-op. Under the CLI there is no preload, so
 * the web bridge (a separate bundle, `apps/cli/src/web-bridge.ts`) provides it
 * from the WebSocket at `/api`. The render waits for it, so `Root` never sees
 * a missing bridge.
 */
async function bootstrap(): Promise<void> {
  const existing = (window as unknown as { anthill?: unknown }).anthill;
  if (!existing) {
    const { installWebBridge } = await import(
      "../../../cli/src/web-bridge"
    );
    await installWebBridge();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

void bootstrap();
