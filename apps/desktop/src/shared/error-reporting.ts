import type { ErrorEvent } from "@sentry/electron/main";

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
    type: "Error",
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
