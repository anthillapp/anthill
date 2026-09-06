/**
 * SQLite-backed implementation of {@link RunStore}.
 *
 * Storage engine decision (2026-08):
 *   1. `node:sqlite` — NOT available on this toolchain (Node v20.18.1 has no such built-in
 *      module; it only ships from Node 22.5+ behind a flag).
 *   2. `better-sqlite3` — installs cleanly here and its native binary loads, so that is what
 *      this module uses. It is synchronous by design; the `RunStore` surface stays `async`
 *      so the backend can be swapped (for `node:sqlite`, or a networked DB) without
 *      touching callers.
 *
 * Layout under `rootDir`:
 *   runs.db                                  — run + node-attempt records
 *   artifacts/<runId>/<nodeId>/<artifactId>  — artifact payloads
 *   logs/<runId>/<nodeId>/<kind>.log         — log payloads
 *
 * Only *references* (paths) to artifacts and logs are kept in the database; the payloads
 * themselves stay on disk so run records remain small and cheap to list.
 */

import Database from "better-sqlite3";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Artifact,
  LogRef,
  NodeRun,
  RunFilter,
  RunStore,
  StoredRun,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowSnapshot,
} from "./contracts.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id               TEXT PRIMARY KEY,
  workflow_id      TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  status           TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  snapshot         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_workflow_id ON runs (workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at);

-- Identity is (run_id, node_id, attempt). The "id" column is the caller's own handle for
-- the attempt and is only unique within a run, so it must not be a global primary key.
CREATE TABLE IF NOT EXISTS node_runs (
  run_id      TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  id          TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  result      TEXT,
  logs        TEXT,
  PRIMARY KEY (run_id, node_id, attempt)
);

CREATE TABLE IF NOT EXISTS logs (
  run_id  TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  kind    TEXT NOT NULL,
  id      TEXT NOT NULL,
  path    TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id, kind)
);
`;

type RunRow = {
  id: string;
  workflow_id: string;
  workflow_version: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  snapshot: string;
};

type NodeRunRow = {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  result: string | null;
  logs: string | null;
};

type LogRow = {
  id: string;
  run_id: string;
  node_id: string;
  kind: string;
  path: string;
};

export type RunStoreOptions = {
  /** Directory that holds `runs.db` plus the `artifacts/` and `logs/` trees. */
  rootDir: string;
  /**
   * Path to a `better_sqlite3.node` binary to load instead of the one resolved
   * from `node_modules`.
   *
   * Needed because a native addon is compiled against one runtime's ABI: the
   * copy installed for Node cannot be loaded by Electron and vice versa
   * (`ERR_DLOPEN_FAILED`). The Electron shell keeps its own Electron-ABI build
   * and points here at it, which leaves the Node-ABI copy — the one this
   * package's own tests use — untouched.
   */
  nativeBinding?: string;
};

/** Thrown when an update targets a run that was never created. */
export class RunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

/**
 * Make an arbitrary id safe to use as a single path segment. Ids come from workflow
 * definitions and agent output, so they must never be able to escape `rootDir`.
 */
function safeSegment(value: string, fallback: string): string {
  // Dots are dropped along with separators so no segment can ever become "." or ".." and
  // so the extension this module appends is the only one in the file name.
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}

const ARTIFACT_EXTENSIONS: Record<string, string> = {
  markdown: ".md",
  md: ".md",
  json: ".json",
  diff: ".diff",
  patch: ".diff",
  html: ".html",
  csv: ".csv",
  log: ".log",
  text: ".txt",
  workflow: ".md",
  report: ".md",
};

function artifactExtension(type: string): string {
  return ARTIFACT_EXTENSIONS[type.toLowerCase()] ?? ".txt";
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function fromJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  return JSON.parse(value) as T;
}

function rowToNodeRun(row: NodeRunRow): NodeRun {
  const nodeRun: NodeRun = {
    id: row.id,
    nodeId: row.node_id,
    attempt: row.attempt,
    status: row.status as NodeRun["status"],
  };
  if (row.started_at !== null) nodeRun.startedAt = row.started_at;
  if (row.finished_at !== null) nodeRun.finishedAt = row.finished_at;
  const result = fromJson<NodeRun["result"]>(row.result);
  if (result !== undefined) nodeRun.result = result;
  const logs = fromJson<LogRef[]>(row.logs);
  if (logs !== undefined) nodeRun.logs = logs;
  return nodeRun;
}

/**
 * Attach store-managed log references (the ones produced by `appendLog`) to the node
 * attempts they belong to.
 *
 * `appendLog` is keyed by `(runId, nodeId, kind)` and therefore has no notion of which
 * attempt was writing. The refs are attached to the *latest* attempt of each node, which is
 * the one a run-detail view shows; refs explicitly recorded on an attempt via
 * `updateNodeRun` are preserved and take precedence (dedup by log id).
 */
function attachLogs(nodeRuns: NodeRun[], logRows: LogRow[]): void {
  if (logRows.length === 0) return;

  const latestAttempt = new Map<string, NodeRun>();
  for (const nodeRun of nodeRuns) {
    const current = latestAttempt.get(nodeRun.nodeId);
    if (current === undefined || nodeRun.attempt >= current.attempt) {
      latestAttempt.set(nodeRun.nodeId, nodeRun);
    }
  }

  const byNode = new Map<string, LogRef[]>();
  for (const row of logRows) {
    const refs = byNode.get(row.node_id) ?? [];
    refs.push({ id: row.id, path: row.path, kind: row.kind });
    byNode.set(row.node_id, refs);
  }

  for (const [nodeId, refs] of byNode) {
    const target = latestAttempt.get(nodeId);
    if (target === undefined) continue;
    const existing = target.logs ?? [];
    const seen = new Set(existing.map((ref) => ref.id));
    target.logs = [...existing, ...refs.filter((ref) => !seen.has(ref.id))];
  }
}

class SqliteRunStore implements RunStore {
  readonly #db: Database.Database;
  readonly #rootDir: string;

  constructor(db: Database.Database, rootDir: string) {
    this.#db = db;
    this.#rootDir = rootDir;
  }

  async createRun(run: WorkflowRun, snapshot: WorkflowSnapshot): Promise<void> {
    const insertRun = this.#db.prepare(
      `INSERT INTO runs (id, workflow_id, workflow_version, status, started_at, finished_at, snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertNodeRun = this.#db.prepare(
      `INSERT INTO node_runs (id, run_id, node_id, attempt, status, started_at, finished_at, result, logs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.#db.transaction(() => {
      insertRun.run(
        run.id,
        run.workflowId,
        run.workflowVersion,
        run.status,
        run.startedAt,
        run.finishedAt ?? null,
        toJson(snapshot),
      );
      for (const nodeRun of run.nodeRuns ?? []) {
        insertNodeRun.run(
          nodeRun.id,
          run.id,
          nodeRun.nodeId,
          nodeRun.attempt,
          nodeRun.status,
          nodeRun.startedAt ?? null,
          nodeRun.finishedAt ?? null,
          nodeRun.result === undefined ? null : toJson(nodeRun.result),
          nodeRun.logs === undefined ? null : toJson(nodeRun.logs),
        );
      }
    });

    tx();
  }

  async updateNodeRun(runId: string, nodeRun: NodeRun): Promise<void> {
    this.#assertRunExists(runId);
    this.#db
      .prepare(
        `INSERT INTO node_runs (id, run_id, node_id, attempt, status, started_at, finished_at, result, logs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, node_id, attempt) DO UPDATE SET
           id          = excluded.id,
           status      = excluded.status,
           started_at  = excluded.started_at,
           finished_at = excluded.finished_at,
           result      = excluded.result,
           logs        = excluded.logs`,
      )
      .run(
        nodeRun.id,
        runId,
        nodeRun.nodeId,
        nodeRun.attempt,
        nodeRun.status,
        nodeRun.startedAt ?? null,
        nodeRun.finishedAt ?? null,
        nodeRun.result === undefined ? null : toJson(nodeRun.result),
        nodeRun.logs === undefined ? null : toJson(nodeRun.logs),
      );
  }

  async updateRunStatus(
    runId: string,
    status: WorkflowRunStatus,
    finishedAt?: string,
  ): Promise<void> {
    this.#assertRunExists(runId);
    if (finishedAt === undefined) {
      this.#db.prepare(`UPDATE runs SET status = ? WHERE id = ?`).run(status, runId);
    } else {
      this.#db
        .prepare(`UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`)
        .run(status, finishedAt, runId);
    }
  }

  async getRun(runId: string): Promise<StoredRun | undefined> {
    const row = this.#db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as
      | RunRow
      | undefined;
    if (row === undefined) return undefined;

    const nodeRuns = this.#nodeRunsFor(runId);
    const run = this.#rowToRun(row, nodeRuns);
    return { ...run, snapshot: JSON.parse(row.snapshot) as WorkflowSnapshot };
  }

  async listRuns(filter?: RunFilter): Promise<WorkflowRun[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.workflowId !== undefined) {
      clauses.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    if (filter?.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.#db
      .prepare(`SELECT * FROM runs${where} ORDER BY started_at DESC, rowid DESC`)
      .all(...params) as RunRow[];

    return rows.map((row) => this.#rowToRun(row, this.#nodeRunsFor(row.id)));
  }

  async saveArtifact(
    runId: string,
    nodeId: string,
    artifact: Artifact,
    content: string,
  ): Promise<Artifact> {
    const dir = path.join(
      this.#rootDir,
      "artifacts",
      safeSegment(runId, "run"),
      safeSegment(nodeId, "node"),
    );
    await mkdir(dir, { recursive: true });

    const fileName = `${safeSegment(artifact.id, "artifact")}${artifactExtension(artifact.type)}`;
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, content, "utf8");

    return { ...artifact, path: filePath };
  }

  async appendLog(
    runId: string,
    nodeId: string,
    kind: string,
    content: string,
  ): Promise<Required<LogRef>> {
    const safeNodeId = safeSegment(nodeId, "node");
    const safeKind = safeSegment(kind, "log");
    const dir = path.join(this.#rootDir, "logs", safeSegment(runId, "run"), safeNodeId);
    await mkdir(dir, { recursive: true });

    const filePath = path.join(dir, `${safeKind}.log`);
    await appendFile(filePath, content, "utf8");

    // Stable id: repeated appends for the same (run, node, kind) reference one file.
    const id = `log_${safeNodeId}_${safeKind}`;
    this.#db
      .prepare(
        `INSERT INTO logs (id, run_id, node_id, kind, path) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id, node_id, kind) DO UPDATE SET path = excluded.path`,
      )
      .run(id, runId, nodeId, kind, filePath);

    return { id, path: filePath, kind };
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  #assertRunExists(runId: string): void {
    const row = this.#db.prepare(`SELECT 1 FROM runs WHERE id = ?`).get(runId);
    if (row === undefined) throw new RunNotFoundError(runId);
  }

  #nodeRunsFor(runId: string): NodeRun[] {
    const rows = this.#db
      .prepare(`SELECT * FROM node_runs WHERE run_id = ? ORDER BY rowid ASC`)
      .all(runId) as NodeRunRow[];
    const nodeRuns = rows.map(rowToNodeRun);

    const logRows = this.#db
      .prepare(`SELECT * FROM logs WHERE run_id = ? ORDER BY rowid ASC`)
      .all(runId) as LogRow[];
    attachLogs(nodeRuns, logRows);

    return nodeRuns;
  }

  #rowToRun(row: RunRow, nodeRuns: NodeRun[]): WorkflowRun {
    const run: WorkflowRun = {
      id: row.id,
      workflowId: row.workflow_id,
      workflowVersion: row.workflow_version,
      status: row.status as WorkflowRunStatus,
      startedAt: row.started_at,
      nodeRuns,
    };
    if (row.finished_at !== null) run.finishedAt = row.finished_at;
    return run;
  }
}

/**
 * Open (creating if necessary) the run store rooted at `options.rootDir`.
 *
 * Safe to call repeatedly against the same `rootDir`: the schema is created idempotently and
 * previously written runs, artifacts and logs are visible to the new handle.
 */
export async function createRunStore(options: RunStoreOptions): Promise<RunStore> {
  const rootDir = path.resolve(options.rootDir);
  await mkdir(rootDir, { recursive: true });
  await mkdir(path.join(rootDir, "artifacts"), { recursive: true });
  await mkdir(path.join(rootDir, "logs"), { recursive: true });

  const db = new Database(
    path.join(rootDir, "runs.db"),
    options.nativeBinding ? { nativeBinding: options.nativeBinding } : undefined,
  );
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  return new SqliteRunStore(db, rootDir);
}
