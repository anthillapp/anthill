import type { ErrorEvent } from "@sentry/electron/main";

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

/** Only packaged Anthill bundle locations may leave the machine in a stack. */
function bundleLocation(value: string | undefined): string {
  if (!value) return "[external]";
  const normalized = value.replaceAll("\\", "/");
  const match = normalized.match(/(?:^|\/)(out\/(?:main|preload|renderer)\/[A-Za-z0-9_./-]+\.(?:js|mjs|cjs))(?:[?#]|$)/);
  return match ? `app:///${match[1]}` : "[external]";
}

/**
 * Preserve stack positions and debug IDs for source maps, but discard runtime
 * values, request context, breadcrumbs, user data, URLs and local file paths.
 */
export function sanitizeErrorEvent(event: ErrorEvent): ErrorEvent {
  const values = event.exception?.values?.map((value) => ({
    type: value.type && BUILT_IN_ERRORS.has(value.type) ? value.type : "Error",
    value: "[redacted]",
    ...(value.stacktrace ? {
      stacktrace: {
        frames: value.stacktrace.frames?.map((frame) => ({
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
