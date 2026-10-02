/**
 * A program that only reports: `node anthill-report.mjs step <runId> <nonce> <stepId>`.
 *
 * The entry scripts/build-plugin-server.mjs bundles into each plugin, so the
 * commands `bind_run` hands a harness work without the CLI installed. Same
 * arguments, same report file and same output as `anthill run/step/done`.
 *
 * It also answers `observation status|enable|skip`, the detailed-progress
 * check the Codex skill runs before a workflow opens. A plugin installed from
 * GitHub has no `anthill` on the PATH, so that check used to fail every time
 * and the hooks question could never be asked (ANT-249).
 */

import { observationCommand } from "./observation.js";
import { reportMain } from "./report-command.js";

const argv = process.argv.slice(2);
if (argv[0] === "observation") {
  const reply = await observationCommand(argv.length === 2 ? argv[1] : undefined);
  console.log(JSON.stringify(reply.result));
  process.exitCode = reply.exitCode;
} else {
  process.exitCode = await reportMain(argv);
}
