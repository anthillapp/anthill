// Test fixture: a well-behaved "agent" CLI.
// Reads the prompt envelope from stdin, prints some chatter, then a JSON
// AgentResult, then more chatter. Exits 0.
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write("[json-agent] warming up...\n");
  process.stdout.write(
    JSON.stringify({
      status: "success",
      summary: "Reviewed the workspace and made no changes.",
      decision: "approve",
      artifacts: [
        { id: "note-1", type: "note", title: "Review note", content: "Looks fine." },
      ],
      issues: [{ severity: "low", title: "Missing README section", file: "README.md" }],
      metrics: { promptLength: prompt.length },
      metadata: { cwd: process.cwd(), sawRole: prompt.includes("Role:") },
    }),
  );
  process.stdout.write("\n[json-agent] done\n");
  process.exit(0);
});
