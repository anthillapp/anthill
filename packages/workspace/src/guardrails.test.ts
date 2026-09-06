import { describe, expect, it } from "vitest"

import { hasUncommittedChanges } from "./guardrails.js"

describe("hasUncommittedChanges", () => {
  it("is false for undefined (not a git repository)", () => {
    expect(hasUncommittedChanges(undefined)).toBe(false)
  })

  it("is false for an empty string (clean working tree)", () => {
    expect(hasUncommittedChanges("")).toBe(false)
  })

  it("is false for whitespace-only output", () => {
    expect(hasUncommittedChanges("\n")).toBe(false)
    expect(hasUncommittedChanges("   ")).toBe(false)
  })

  it("is true for a modified tracked file", () => {
    expect(hasUncommittedChanges(" M src/index.ts\n")).toBe(true)
  })

  it("is true for a staged file", () => {
    expect(hasUncommittedChanges("A  src/new.ts\n")).toBe(true)
  })

  it("is true for an untracked file", () => {
    expect(hasUncommittedChanges("?? notes.md\n")).toBe(true)
  })

  it("is true for multi-line porcelain output", () => {
    expect(hasUncommittedChanges(" M a.ts\n?? b.ts\nD  c.ts\n")).toBe(true)
  })

  it("does not mutate or depend on anything but its argument", () => {
    const input = " M a.ts\n"
    expect(hasUncommittedChanges(input)).toBe(true)
    expect(hasUncommittedChanges(input)).toBe(true)
    expect(input).toBe(" M a.ts\n")
  })
})
