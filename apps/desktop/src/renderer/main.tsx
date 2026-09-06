import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// React Flow ships its own stylesheet; `@anthill/builder` deliberately does not
// import it so the library stays bundler-agnostic. The app entry must.
import "@xyflow/react/dist/style.css";
import "./styles.css";

import { Root } from "./Root.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
