/**
 * `anthill workflow export <id> [--format svg] [--out <path>] [--data-dir <p>]`
 *
 * Writes the workflow's execution flow — the diagram the app draws, laid out
 * exactly as drawn — to a self-contained vector file. Like the report
 * subcommands, it is a short command: no server, no lock.
 *
 * The rendering itself lives in `workflow-export-entry.ts`, which vite
 * bundles (it imports the desktop renderer's `LiveWorkflowGraph` and React,
 * which the tsc-compiled CLI cannot load from source). This module parses
 * the arguments and hands off to that bundle, imported at the point of use
 * so the React cost is paid only by the one command that needs it.
 */

function usage(): string {
  return [
    "usage: anthill workflow export <id> [--format svg] [--out <path>] [--data-dir <p>]",
    "",
    "  Exports the workflow's execution flow as a self-contained vector file",
    "  (<name>.ahl.svg next to the workflow file, or --out).",
  ].join("\n");
}

function fail(message: string): never {
  console.error(`anthill: ${message}`);
  console.error(usage());
  process.exit(1);
}

export async function workflowCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "export") {
    console.error(`anthill: unknown workflow command: ${sub ?? ""}`);
    console.error(usage());
    return 1;
  }

  let id: string | undefined;
  let format = "svg";
  let out: string | undefined;
  let dataDir: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--format") {
      const value = rest[++i];
      if (value === undefined) fail("--format needs a value");
      format = value;
    } else if (arg === "--out") {
      const value = rest[++i];
      if (value === undefined) fail("--out needs a value");
      out = value;
    } else if (arg === "--data-dir") {
      const value = rest[++i];
      if (value === undefined) fail("--data-dir needs a value");
      dataDir = value;
    } else if (arg.startsWith("-")) {
      fail(`unknown argument: ${arg}`);
    } else if (id === undefined) {
      id = arg;
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }
  if (id === undefined) fail("workflow export needs a workflow id");

  try {
    // The bundled entry (vite), not the source: the CLI is tsc-compiled and
    // cannot load the renderer's .tsx from source. The bundle exists after
    // `npm run build` (vite runs after tsc), so tsc cannot see the module.
    // @ts-expect-error the module is the vite bundle, built after tsc runs
    const { exportWorkflowSvg } = await import("../../renderer/workflow-export.js");
    const path = await exportWorkflowSvg({ id, format, out, dataDir });
    console.log(path);
    return 0;
  } catch (error) {
    console.error(`anthill: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
