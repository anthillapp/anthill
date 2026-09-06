/** Dev-only config for the `dev/` harness (`npm run dev`). Not used for builds. */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "dev",
  plugins: [react()],
  server: { port: 5273 },
});
