/**
 * The report subcommands, `anthill run/step/done`, on their own.
 *
 * They are what a harness runs on every step, so they are kept apart from the
 * web shell: cli.ts dispatches to them, and report-main.ts runs nothing else.
 * scripts/build-plugin-server.mjs bundles report-main.ts into each plugin as
 * server/anthill-report.mjs, so a harness with no `anthill` on its PATH (an
 * installed app, no CLI) still has a command to report with. Nothing here
 * starts a server, takes the instance lock or sends diagnostics.
 */

import type { HarnessReport } from "@anthill/live";

import { resolvePaths } from "./paths.js";
import { appendReport } from "./report.js";

/** What the report subcommands accept. */
export const REPORT_USAGE = [
  "usage: anthill run <runId> <nonce>",
  "       anthill step <runId> <nonce> <stepId>",
  "       anthill done <runId> <nonce>",
  "       … --data-dir <dir>   write the report where a web shell started with --data-dir reads it",
].join("\n");

function fail(message: string): never {
  console.error(`anthill: ${message}`);
  console.error(REPORT_USAGE);
  process.exit(1);
}

/**
 * Pull `--data-dir` out of the report subcommands' argv.
 *
 * The subcommands resolve their own paths (no server), so `--data-dir` is
 * the one option they accept: a server started with `--data-dir X` reads
 * reports from `X`, and a harness that reports with `--data-dir X` writes
 * them there — the two agree on where the report file lives. A value that
 * looks like an option is rejected, the same rule as `parseArgs`: a
 * swallowed flag is how `--data-dir --port` would become a path.
 */
export function extractDataDir(
  argv: string[],
): { dataDir: string | undefined; argv: string[] } {
  let dataDir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--data-dir") {
      const next = argv[i + 1];
      if (next === undefined) fail("--data-dir needs a value");
      if (next.startsWith("-")) {
        fail(
          `--data-dir needs a value, but the next argument (${next}) looks like an option. ` +
            `Pass the value with --data-dir=<value>, or move ${next} after the value.`,
        );
      }
      dataDir = next;
      i += 1;
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else {
      rest.push(arg);
    }
  }
  return { dataDir, argv: rest };
}

/**
 * The report subcommands: `anthill run <runId> <nonce>`,
 * `anthill step <runId> <nonce> <stepId>`, and
 * `anthill done <runId> <nonce>`.
 *
 * These are what the prompt tells the harness to run. They append one line
 * to the report file and exit. They never start the server and never take
 * the instance lock, so a harness mid-step cannot be blocked by a running
 * Anthill, and a harness on a machine without one simply gets an error.
 *
 * `write` is injected so a test can record the report instead of touching
 * the file system.
 */
export async function runReportCommand(
  argv: string[],
  write: (report: HarnessReport) => Promise<void>,
): Promise<number> {
  const [command, ...values] = argv;
  if (command !== "run" && command !== "step" && command !== "done") {
    console.error(`anthill: unknown command: ${command ?? ""}\n\n${REPORT_USAGE}`);
    return 1;
  }
  const expected = command === "step" ? 3 : 2;
  if (values.length !== expected) {
    console.error(
      command === "run"
        ? "usage: anthill run <runId> <nonce>"
        : command === "step"
          ? "usage: anthill step <runId> <nonce> <stepId>"
          : "usage: anthill done <runId> <nonce>",
    );
    return 1;
  }
  const bad = values.find((value) => value.length === 0 || /\s/.test(value));
  if (bad !== undefined) {
    console.error("Report values must be non-empty and contain no whitespace.");
    return 1;
  }
  try {
    if (command === "run") {
      await write({ kind: "run", runId: values[0]!, nonce: values[1]!, at: new Date().toISOString() });
    } else if (command === "step") {
      await write({ kind: "step", runId: values[0]!, nonce: values[1]!, stepId: values[2]!, at: new Date().toISOString() });
    } else {
      await write({ kind: "done", runId: values[0]!, nonce: values[1]!, at: new Date().toISOString() });
    }
  } catch (problem) {
    console.error(problem instanceof Error ? problem.message : "The report could not be written.");
    return 1;
  }
  console.log(
    command === "run"
      ? "Run reported."
      : command === "step"
        ? `Step ${values[2]!} reported.`
        : "Done reported.",
  );
  return 0;
}

/** `anthill run/step/done …`: write the report where it is read, and say so. */
export async function reportMain(argv: string[]): Promise<number> {
  const { dataDir, argv: command } = extractDataDir(argv);
  const paths = await resolvePaths({ dataDir });
  return runReportCommand(command, (report) => appendReport(paths, report));
}
