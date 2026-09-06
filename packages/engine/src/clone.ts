/**
 * Dependency-free deep clone for the JSON-shaped values this package moves
 * around (`WorkflowRun`, `NodeRun`, `AgentResult`, node configs).
 *
 * We do not use `structuredClone` because the package targets `lib: ES2022`
 * without DOM or Node type packages, and we do not use a JSON round-trip
 * because it silently drops `undefined` values and mangles dates.
 *
 * Arrays, plain objects, and `Date`s are copied; anything else (functions,
 * class instances, Map/Set) is passed through by reference — run traces never
 * contain those.
 */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = deepClone(item);
  }
  return out as T;
}

/** RFC-4122-ish id: uses `crypto.randomUUID` when the host provides it. */
export function randomId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoRef?.randomUUID === "function") return cryptoRef.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
