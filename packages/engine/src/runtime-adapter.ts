/**
 * Bridges `@anthill/runtimes`' `AgentRuntime` interface to the engine's own
 * `RuntimeAdapterPort`.
 *
 * The two packages were built in parallel against slightly different
 * boundaries: `AgentRuntime.run()` returns `{ result, raw }` (the normalized
 * result plus untouched process evidence, useful for observability), while
 * the engine only needs the normalized `AgentResult` to decide how to route
 * edges. This adapter also translates the engine's node-shaped context
 * (`workflow` + `node`) into the flat `AgentRunContext` runtimes expect.
 */

import type { AgentRuntime } from "@anthill/runtimes";
import type { AgentResult } from "@anthill/workflow-schema";
import type { RuntimeAdapterPort, RuntimeRunContext } from "./contracts.js";

function readConfigString(
  node: RuntimeRunContext["node"],
  key: string,
): string | undefined {
  const value = node.config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Wrap an `AgentRuntime` (from `@anthill/runtimes`) as a `RuntimeAdapterPort`. */
export function adaptAgentRuntime(runtime: AgentRuntime): RuntimeAdapterPort {
  return {
    id: runtime.id,
    async run(ctx: RuntimeRunContext): Promise<AgentResult> {
      const workingDirectory =
        readConfigString(ctx.node, "workingDirectory") ?? process.cwd();
      const role = readConfigString(ctx.node, "role") ?? ctx.node.name;
      const timeoutMsRaw = ctx.node.config.timeoutMs;
      const timeoutMs = typeof timeoutMsRaw === "number" ? timeoutMsRaw : undefined;

      const { result } = await runtime.run({
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        attempt: ctx.attempt,
        workingDirectory,
        instructions: ctx.instructions,
        role,
        priorResults: ctx.priorResults,
        timeoutMs,
      });
      return result;
    },
  };
}
