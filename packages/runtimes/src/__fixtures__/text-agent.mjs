// Test fixture: an "agent" CLI that prints free text and exits 0.
// Used to exercise the no-parseable-JSON fallback branch.
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(`I read a prompt of ${prompt.length} characters and did the thing.\n`);
  process.exit(0);
});
