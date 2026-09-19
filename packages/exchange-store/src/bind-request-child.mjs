import { ExchangeStore } from "../dist/index.js";

const [root, digest, runId, start] = process.argv.slice(2);
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(start) - Date.now())));
const store = new ExchangeStore(root);
const result = await store.bindRequest("workflow-1", 1, digest, "same-request", "session-abc",
  () => ({ runId, nonce: "nonce" }));
process.stdout.write(JSON.stringify(result));
