import type { ErrorEvent } from "@sentry/electron/main";

/** Public client configuration: the key only lets a client send events. */
export const SENTRY_DSN = "https://0d9d9c4af97fd9088c38cf794e2ef71d@o4512154362183680.ingest.us.sentry.io/4512154370834432";

/** Enough of a report to find the fault; a larger one is cut, not sent whole. */
const MAX_EXCEPTIONS = 5;
const MAX_FRAMES = 100;

/** Built-in error classes: they name a kind of failure and carry no user data. */
const BUILT_IN_ERRORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
]);

/**
 * Only Anthill's own bundle locations may leave the machine in a stack: the
 * desktop's `out/`, the CLI's `apps/cli/out/`, and the CLI's renderer assets
 * as a browser names them. The checkout path, host and port are dropped.
 */
function bundleLocation(value: string | undefined): string {
  if (!value) return "[external]";
  const normalized = value.replaceAll("\\", "/");
  const file = "[A-Za-z0-9_./-]+\\.(?:js|mjs|cjs)";
  const cli = normalized.match(new RegExp(`(?:^|/)apps/cli/out/(${file})(?:[?#]|$)`));
  if (cli && !cli[1].includes("node_modules/")) return `app:///cli/${cli[1]}`;
  const desktop = normalized.match(new RegExp(`(?:^|/)(out/(?:main|preload|renderer)/${file})(?:[?#]|$)`));
  if (desktop) return `app:///${desktop[1]}`;
  const served = normalized.match(new RegExp(`^https?://[^/]+/(assets/${file})(?:[?#]|$)`));
  if (served) return `app:///cli/renderer/${served[1]}`;
  return "[external]";
}

/**
 * Preserve stack positions and debug IDs for source maps, but discard runtime
 * values, request context, breadcrumbs, user data, URLs and local file paths.
 */
export function sanitizeErrorEvent(event: ErrorEvent): ErrorEvent {
  const values = event.exception?.values?.slice(-MAX_EXCEPTIONS).map((value) => ({
    type: value.type && BUILT_IN_ERRORS.has(value.type) ? value.type : "Error",
    value: "[redacted]",
    ...(value.stacktrace ? {
      stacktrace: {
        // The innermost frames are last, and they are the ones worth keeping.
        frames: value.stacktrace.frames?.slice(-MAX_FRAMES).map((frame) => ({
          filename: bundleLocation(frame.filename),
          abs_path: bundleLocation(frame.abs_path),
          lineno: frame.lineno,
          colno: frame.colno,
          in_app: frame.in_app,
        })),
      },
    } : {}),
  }));
  return {
    type: event.type,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    // Without `infer_ip: "never"` Sentry falls back to storing the sender's IP
    // for JavaScript events, so the SDK block is kept with that setting forced.
    sdk: event.sdk ? {
      name: event.sdk.name,
      version: event.sdk.version,
      settings: { infer_ip: "never" },
    } : undefined,
    exception: values ? { values } : undefined,
    debug_meta: event.debug_meta ? {
      images: event.debug_meta.images?.filter((entry) => entry.type === "sourcemap").map((entry) => ({
        type: "sourcemap",
        debug_id: entry.debug_id,
        code_file: bundleLocation(entry.code_file),
      })),
    } : undefined,
  };
}
