/**
 * A program that only reports: `node anthill-report.mjs step <runId> <nonce> <stepId>`.
 *
 * The entry scripts/build-plugin-server.mjs bundles into each plugin, so the
 * commands `bind_run` hands a harness work without the CLI installed. Same
 * arguments, same report file and same output as `anthill run/step/done`.
 */

import { reportMain } from "./report-command.js";

process.exitCode = await reportMain(process.argv.slice(2));
