/**
 * `@anthill/workflow-schema` — the canonical workflow data model.
 *
 * - `./types`    TypeScript contract shared by every other `@anthill/*` package
 * - `./schemas`  zod mirrors + `parseWorkflow`
 * - `./validate` graph validation + edge-condition grammar
 */

export const PACKAGE_NAME = "@anthill/workflow-schema";

export * from "./types.js";
export * from "./schemas.js";
export * from "./validate.js";
