/**
 * The revision digest: two submissions of the same content are one revision,
 * and any change of content is a different one.
 *
 * The SHA-256 here is hand-written, so it is checked against the published
 * vectors rather than against itself.
 */

import { describe, expect, it } from "vitest";

import { canonicalJson, revisionDigest, sha256Hex } from "./digest.js";

describe("sha256Hex", () => {
  it("matches the published vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("hashes across block boundaries", () => {
    // 55, 56 and 64 bytes: the last input that fits with its padding, the first
    // that spills into a second block, and an exact block. A padding mistake
    // shows up here and nowhere else.
    expect(sha256Hex("a".repeat(55))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
    );
    expect(sha256Hex("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
    );
    expect(sha256Hex("a".repeat(64))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
  });

  it("hashes text beyond ASCII as its UTF-8 bytes", () => {
    // Two bytes and four bytes: the branches of the encoder a workflow written
    // in something other than English reaches. Both answers are node's.
    expect(sha256Hex("ü")).toBe(
      "607474ca475a9724d7360aba71a56d5df77e61350e3f724cfa1f46e857e2d85f",
    );
    expect(sha256Hex("😀")).toBe(
      "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9",
    );
  });

  it("replaces an unpaired surrogate rather than throwing", () => {
    const replacement = "83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097";
    expect(sha256Hex("\ud83d")).toBe(replacement);
    expect(sha256Hex("\udc00")).toBe(replacement);
  });
});

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps array order, because node order is content", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined members, the way JSON.stringify does", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("revisionDigest", () => {
  const workflow = {
    id: "workflow-1",
    name: "Ship the fix",
    version: "0.1.0",
    nodes: [{ id: "start", type: "start", name: "Start", config: {} }],
    edges: [],
  };

  it("is sixteen hex characters", () => {
    expect(revisionDigest(workflow)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is the same whatever order the keys were written in", () => {
    const reordered = {
      edges: [],
      nodes: [{ config: {}, name: "Start", type: "start", id: "start" }],
      version: "0.1.0",
      name: "Ship the fix",
      id: "workflow-1",
    };
    expect(revisionDigest(reordered)).toBe(revisionDigest(workflow));
  });

  it("changes when anything the user would notice changes", () => {
    expect(revisionDigest({ ...workflow, name: "Ship the other fix" })).not.toBe(
      revisionDigest(workflow),
    );
    expect(
      revisionDigest({
        ...workflow,
        nodes: [...workflow.nodes, { id: "end", type: "end", name: "End", config: {} }],
      }),
    ).not.toBe(revisionDigest(workflow));
  });

  it("does not change when a field is absent rather than undefined", () => {
    expect(revisionDigest({ ...workflow, brief: undefined })).toBe(revisionDigest(workflow));
  });
});
