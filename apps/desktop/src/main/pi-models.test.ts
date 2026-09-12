import { describe, expect, it } from "vitest";

import type { SpawnFn } from "@anthill/runtimes";

import { parsePiModels, PI_THINKING_LEVELS, readPiModels } from "./pi-models.js";

/** A `SpawnFn` that reports a fixed stdout and exit code, or a spawn error. */
function fakeSpawn(stdout: string, exitCode = 0): SpawnFn {
  return () => ({
    stdout: {
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "data") listener(stdout);
        return undefined;
      },
      setEncoding() {
        return undefined;
      },
    },
    stderr: { on: () => undefined, setEncoding() {
        return undefined;
      } },
    stdin: {
      write: () => undefined,
      end: () => undefined,
      on: () => undefined,
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === "close") listener(exitCode);
      return undefined;
    },
    kill: () => undefined,
  });
}

describe("parsePiModels", () => {
  it("parses a table row into a model option", () => {
    const output = [
      "provider   model                  context  max-out  thinking  images",
      "llama-cpp  qwen36-27b-q5-fullctx  114.7K   65K      yes       yes",
    ].join("\n");
    expect(parsePiModels(output)).toEqual({
      models: [
        {
          id: "llama-cpp/qwen36-27b-q5-fullctx",
          label: "qwen36-27b-q5-fullctx",
          efforts: PI_THINKING_LEVELS.map((level) => ({ id: level })),
        },
      ],
    });
  });

  it("offers no efforts for a model that cannot think", () => {
    const output = [
      "provider   model      context  max-out  thinking  images",
      "llama-cpp  small-4b   8K       4K       no        no",
    ].join("\n");
    expect(parsePiModels(output)).toEqual({
      models: [{ id: "llama-cpp/small-4b", label: "small-4b", efforts: [] }],
    });
  });

  it("skips the header row and blank lines", () => {
    const output = [
      "provider   model      context  max-out  thinking  images",
      "",
      "llama-cpp  small-4b   8K       4K       yes       no",
    ].join("\n");
    expect(parsePiModels(output)).toEqual({
      models: [
        {
          id: "llama-cpp/small-4b",
          label: "small-4b",
          efforts: PI_THINKING_LEVELS.map((level) => ({ id: level })),
        },
      ],
    });
  });

  it("parses several rows in order", () => {
    const output = [
      "provider   model      context  max-out  thinking  images",
      "llama-cpp  small-4b   8K       4K       yes       no",
      "llama-cpp  big-70b    128K     8K       no        no",
    ].join("\n");
    expect(parsePiModels(output)?.models.map((model) => model.id)).toEqual([
      "llama-cpp/small-4b",
      "llama-cpp/big-70b",
    ]);
  });

  it("is undefined for a table with no data rows", () => {
    expect(
      parsePiModels("provider   model      context  max-out  thinking  images"),
    ).toBeUndefined();
  });

  it("is undefined for empty output", () => {
    expect(parsePiModels("")).toBeUndefined();
  });

  it("ignores a line that is not a data row", () => {
    const output = [
      "provider   model      context  max-out  thinking  images",
      "some stray line",
    ].join("\n");
    expect(parsePiModels(output)).toBeUndefined();
  });
});

describe("readPiModels", () => {
  it("asks pi for its models and parses them", async () => {
    const output = [
      "provider   model      context  max-out  thinking  images",
      "llama-cpp  small-4b   8K       4K       yes       no",
    ].join("\n");
    const result = await readPiModels({ spawnFn: fakeSpawn(output) });
    expect(result).toEqual({
      models: [
        {
          id: "llama-cpp/small-4b",
          label: "small-4b",
          efforts: PI_THINKING_LEVELS.map((level) => ({ id: level })),
        },
      ],
    });
  });

  it("is undefined when the CLI cannot be spawned", async () => {
    const result = await readPiModels({
      spawnFn: () => {
        throw new Error("pi: command not found");
      },
    });
    expect(result).toBeUndefined();
  });

  it("is undefined when the CLI exits non-zero", async () => {
    const result = await readPiModels({ spawnFn: fakeSpawn("", 1) });
    expect(result).toBeUndefined();
  });
});
