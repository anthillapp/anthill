/**
 * The workflows this machine has open recently.
 *
 * The launch window's whole point is that what you came back for is already on
 * screen, so the list has to say enough to recognise a workflow without opening it:
 * its name, where it lives, when it was last touched, and what shape it is.
 *
 * The shape — "5 blocks · 2 agents · Claude Code" — is read from the file
 * itself. That means parsing each remembered workflow on the way in, which is
 * cheap for a handful of small JSON documents and honest in a way a cached
 * summary would not be: a workflow edited by something other than Anthill still
 * describes itself correctly.
 *
 * The list is a UI convenience, not project data. A file that has been moved or
 * deleted simply drops out.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RecentWorkflow } from "../shared/ipc.js";
import { CLI_LABEL, isMarkerCli } from "@anthill/live";

/** How many to remember. Long enough to find last week's, short enough to scan. */
const LIMIT = 12;

type Stored = { paths: string[] };

const EMPTY: Stored = { paths: [] };

/**
 * Where this store lives and what `~` means. Injected rather than read from a
 * host API, so the same module runs in Electron (the app sets the Electron
 * paths at startup) and in the CLI (which sets its own data dir and home).
 */
let recentsPaths: { userData: string; home: string } = {
  userData: "",
  home: "",
};

export function setRecentsPaths(paths: { userData: string; home: string }): void {
  recentsPaths = paths;
}

function storePath(): string {
  return join(recentsPaths.userData, "recent-workflows.json");
}

/**
 * Where this list lived before the file was renamed.
 *
 * Read once, when the new file is not there yet. Renaming a file in userData
 * without this does not error — it silently presents an empty list, which
 * reads as "you have never opened anything" to someone who has.
 */
function legacyStorePath(): string {
  return join(recentsPaths.userData, "recent-plans.json");
}

async function read(): Promise<Stored> {
  try {
    const text = await readFile(storePath(), "utf8").catch(() =>
      readFile(legacyStorePath(), "utf8"),
    );
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return EMPTY;
    const record = raw as Record<string, unknown>;
    return {
      paths: Array.isArray(record.paths)
        ? record.paths.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    // No store yet, or one this build cannot read. Either way, start clean
    // rather than failing to open the window.
    return EMPTY;
  }
}

async function write(next: Stored): Promise<void> {
  try {
    await mkdir(dirname(storePath()), { recursive: true });
    await writeFile(storePath(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    // A list of recent files is not worth failing a save over.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * "5 blocks · 2 agents · Claude Code", read from the workflow itself.
 *
 * Exported for its own test: this reads raw JSON off disk rather than a
 * migrated workflow, which is a difference that has already cost one
 * regression.
 */
export function describeWorkflow(
  workflow: unknown,
):
  | {
      name?: string;
      workflowId?: string;
      steps?: Record<string, string>;
      libraryAgentIds?: string[];
      meta: string;
    }
  | undefined {
  if (!isRecord(workflow) || !Array.isArray(workflow.nodes)) return undefined;

  const blocks = workflow.nodes.length;
  // Read straight off disk, so the file has not been through `migrateWorkflow`
  // yet — anything saved before format 5 still keeps this under the old key,
  // and reading only the new one reported every one of them as having no
  // agents at all.
  const metadata = isRecord(workflow.metadata) ? workflow.metadata : {};
  const bag = metadata.workflow ?? metadata.planner;
  const profiles = isRecord(bag) && Array.isArray(bag.agents) ? bag.agents : [];
  const agents = profiles.length;
  // Which global library profiles this workflow holds a copy of. Carried for
  // the same reason as `steps`: the launch window has no workflow loaded and
  // still has to say whether deleting a library profile would orphan anything,
  // and the file is being parsed here anyway.
  const libraryAgentIds = [
    ...new Set(
      profiles.flatMap((profile) =>
        isRecord(profile) && typeof profile.libraryId === "string" && profile.libraryId
          ? [profile.libraryId]
          : [],
      ),
    ),
  ];
  const target = workflow.target;
  const harness = isMarkerCli(target) ? CLI_LABEL[target] : undefined;

  return {
    ...(typeof workflow.name === "string" && workflow.name.trim() ? { name: workflow.name } : {}),
    // The workflow's own id, so the launch window can tell which of these files an
    // observation belongs to without matching on a name two workflows could share.
    ...(typeof workflow.id === "string" && workflow.id ? { workflowId: workflow.id } : {}),
    ...(libraryAgentIds.length > 0 ? { libraryAgentIds } : {}),
    steps: Object.fromEntries(
      workflow.nodes
        .filter(
          (node): node is Record<string, unknown> =>
            isRecord(node) && node.type !== "start" && node.type !== "end",
        )
        .map((node) => [String(node.id), String(node.name ?? node.id)]),
    ),
    meta: [
      `${blocks} ${blocks === 1 ? "block" : "blocks"}`,
      `${agents} ${agents === 1 ? "agent" : "agents"}`,
      ...(harness ? [harness] : []),
    ].join(" · "),
  };
}

/** Home-relative, because `~/workflows/x.json` is readable and the full path is not. */
function shorten(path: string): string {
  const home = recentsPaths.home;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * The remembered workflows that still exist, newest first.
 *
 * A file that has gone is dropped rather than shown as a dead row: the list is
 * there to be clicked, and a row that cannot be opened is worse than one fewer.
 */
export async function listRecents(): Promise<RecentWorkflow[]> {
  const { paths } = await read();

  const found = await Promise.all(
    paths.map(async (path): Promise<RecentWorkflow | undefined> => {
      try {
        const info = await stat(path);
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        const described = describeWorkflow(parsed);
        if (!described) return undefined;
        return {
          path,
          displayPath: shorten(path),
          name: described.name ?? path.split("/").pop() ?? path,
          ...(described.workflowId ? { workflowId: described.workflowId } : {}),
          ...(described.steps ? { steps: described.steps } : {}),
          ...(described.libraryAgentIds ? { libraryAgentIds: described.libraryAgentIds } : {}),
          meta: described.meta,
          modifiedAt: info.mtime.toISOString(),
        };
      } catch {
        return undefined;
      }
    }),
  );

  return found
    .filter((item): item is RecentWorkflow => item !== undefined)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Remember a workflow, most recent first, without letting the list grow forever. */
export async function rememberRecent(path: string): Promise<void> {
  const current = await read();
  const paths = [path, ...current.paths.filter((item) => item !== path)].slice(0, LIMIT);
  await write({ ...current, paths });
}

export async function forgetRecent(path: string): Promise<void> {
  const current = await read();
  await write({ ...current, paths: current.paths.filter((item) => item !== path) });
}

