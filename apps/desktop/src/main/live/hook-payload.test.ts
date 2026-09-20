/**
 * What a hook is allowed to write down (ANT-98).
 *
 * The handler appended the payload whole. For Claude Code that carries the
 * full shell command of a `Bash` call and the full contents of a `Write`, so a
 * session that exported a token put it in `~/.anthill/live-hooks/events.jsonl`
 * permanently — and Anthill then drew it in the Live Session feed.
 *
 * These payloads carry credentials on purpose. What each test asserts is not
 * that a particular pattern was matched, but that the secret is not in the
 * output at all.
 */

import { describe, expect, it } from "vitest";

import { minimalHookPayload, redactSecrets } from "./hook-payload.js";

const serialised = (value: unknown) => JSON.stringify(value);

describe("reducing a hook payload", () => {
  it("keeps the identifiers the observer reads", () => {
    const out = minimalHookPayload({
      session_id: "0c379b26-8ece-41b7-a710-500b442055ed",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_01ABC",
      duration_ms: 1234,
    });
    expect(out).toMatchObject({
      session_id: "0c379b26-8ece-41b7-a710-500b442055ed",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_01ABC",
      duration_ms: 1234,
    });
  });

  it("drops every field nobody reads, without looking at them", () => {
    const out = minimalHookPayload({
      session_id: "s1",
      transcript_path: "/Users/me/.claude/projects/x.jsonl",
      cwd: "/Users/me/secret-project",
      permission_mode: "acceptEdits",
      environment: { AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI" },
      something_a_future_harness_adds: "anything at all",
    });
    expect(Object.keys(out)).toEqual(["session_id"]);
  });

  /** The case the ticket is about. */
  it("does not keep the command a Bash call ran", () => {
    const out = minimalHookPayload({
      tool_name: "Bash",
      tool_input: { command: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY aws s3 ls" },
    });
    expect(serialised(out)).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCY");
  });

  it("does not keep the contents a Write call wrote", () => {
    const out = minimalHookPayload({
      tool_name: "Write",
      tool_input: {
        file_path: "/Users/me/app/.env",
        content: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345\n",
      },
    });
    expect(serialised(out)).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz012345");
    // The path is what the feed shows, and it survives.
    expect(out.tool_input).toMatchObject({ file_path: "/Users/me/app/.env" });
  });

  it("records only that a tool answered, never what it answered", () => {
    const out = minimalHookPayload({
      tool_name: "Read",
      tool_response: { file: { content: "ghp_abcdefghijklmnopqrstuvwxyz0123" } },
    });
    expect(out.tool_response).toBe(true);
    expect(serialised(out)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });

  it("redacts a secret carried in a description the feed does show", () => {
    const out = minimalHookPayload({
      tool_name: "Bash",
      tool_input: { description: "Deploy with token ghp_abcdefghijklmnopqrstuvwxyz0123" },
    });
    expect(serialised(out)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(serialised(out)).toContain("Deploy with token");
  });

  it("truncates a value long enough to be a payload rather than a label", () => {
    const out = minimalHookPayload({
      tool_name: "Bash",
      tool_input: { description: "x".repeat(5000) },
    });
    expect(String((out.tool_input as Record<string, string>).description).length).toBeLessThan(250);
  });

  it("keeps nothing at all from input it could not parse", () => {
    // The handler turns unparseable stdin into `{ raw: … }`, which is not a
    // field anybody reads — so it is dropped like any other.
    expect(minimalHookPayload({ raw: "PASSWORD=hunter2 everything else" })).toEqual({});
  });
});

describe("redacting", () => {
  const SECRETS = [
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG", "wJalrXUtnFEMIK7MDENG"],
    ["--api-key=sk-proj-abcdefghijklmnop012345", "sk-proj-abcdefghijklmnop012345"],
    ['password: "hunter2hunter2"', "hunter2hunter2"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9", "eyJhbGciOiJIUzI1NiJ9"],
    ["export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
    ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  ] as const;

  it("removes the value and keeps what it was called", () => {
    for (const [text, secret] of SECRETS) {
      const out = redactSecrets(text);
      expect(out, text).not.toContain(secret);
      expect(out, text).toContain("[redacted]");
    }
  });

  it("removes a private key block entirely", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`here it is ${key} and after`)).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("leaves ordinary text alone", () => {
    const ordinary = "npm run build --workspace=@anthill/desktop";
    expect(redactSecrets(ordinary)).toBe(ordinary);
  });
});
