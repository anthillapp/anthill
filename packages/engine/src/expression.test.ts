import { describe, expect, it } from "vitest";

import {
  ExpressionError,
  evaluateExpression,
  isValidExpression,
  parseExpression,
  resolvePath,
} from "./expression.js";

const context = {
  review: {
    status: "success",
    decision: "approved",
    summary: "looks good",
    issues: [{ severity: "high", title: "missing test" }],
    metadata: { retryable: false, attempts: 2, owner: null },
  },
  "dev-node": { status: "success", decision: "done" },
};

describe("parseExpression", () => {
  it("parses a dotted path, operator, and string literal", () => {
    expect(parseExpression('review.status == "approved"')).toEqual({
      path: ["review", "status"],
      operator: "==",
      value: "approved",
    });
  });

  it("parses != and single-quoted literals", () => {
    expect(parseExpression("review.decision != 'changes_requested'")).toEqual({
      path: ["review", "decision"],
      operator: "!=",
      value: "changes_requested",
    });
  });

  it("parses boolean, null, and numeric literals", () => {
    expect(parseExpression("a.b == true").value).toBe(true);
    expect(parseExpression("a.b == false").value).toBe(false);
    expect(parseExpression("a.b == null").value).toBe(null);
    expect(parseExpression("a.b == 3").value).toBe(3);
    expect(parseExpression("a.b == -2.5").value).toBe(-2.5);
  });

  it("tolerates missing whitespace and extra whitespace", () => {
    expect(parseExpression('review.status=="approved"').value).toBe("approved");
    expect(parseExpression('   review.status   ==   "approved"  ').value).toBe("approved");
  });

  it("supports kebab-case node ids and numeric array indexes", () => {
    expect(parseExpression('dev-node.status == "success"').path).toEqual(["dev-node", "status"]);
    expect(parseExpression('review.issues.0.severity == "high"').path).toEqual([
      "review",
      "issues",
      "0",
      "severity",
    ]);
  });

  it("unescapes escaped characters inside string literals", () => {
    expect(parseExpression('a.b == "say \\"hi\\""').value).toBe('say "hi"');
    expect(parseExpression('a.b == "line\\nbreak"').value).toBe("line\nbreak");
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["review.status", "no operator"],
    ['review.status = "approved"', "single equals"],
    ['review.status === "approved"', "strict equals"],
    ["review.status > 3", "unsupported operator"],
    ['review.status == approved', "unquoted right-hand side"],
    ['"approved" == review.status', "literal on the left"],
    ['review.status == "a" && review.decision == "b"', "boolean combinator"],
    ['review["status"] == "a"', "bracket access"],
    ["review.status == ", "missing literal"],
    ['review..status == "a"', "empty path segment"],
    ['1review.status == "a"', "segment starting with a digit"],
  ])("rejects %j (%s)", (expression) => {
    expect(() => parseExpression(expression)).toThrow(ExpressionError);
    expect(isValidExpression(expression)).toBe(false);
  });

  it("includes the offending expression in the error", () => {
    try {
      parseExpression("review.status ~ 1");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ExpressionError);
      expect((error as ExpressionError).expression).toBe("review.status ~ 1");
      expect((error as ExpressionError).message).toContain("review.status ~ 1");
    }
  });
});

describe("resolvePath", () => {
  it("reads nested values", () => {
    expect(resolvePath(context, ["review", "metadata", "attempts"])).toBe(2);
    expect(resolvePath(context, ["review", "issues", "0", "title"])).toBe("missing test");
  });

  it("returns undefined for missing or non-object segments", () => {
    expect(resolvePath(context, ["nope", "status"])).toBeUndefined();
    expect(resolvePath(context, ["review", "summary", "length", "deep"])).toBeUndefined();
    expect(resolvePath(undefined, ["a"])).toBeUndefined();
  });
});

describe("evaluateExpression", () => {
  it("evaluates == and != against the context", () => {
    expect(evaluateExpression('review.status == "success"', context)).toBe(true);
    expect(evaluateExpression('review.status == "failed"', context)).toBe(false);
    expect(evaluateExpression('review.status != "failed"', context)).toBe(true);
    expect(evaluateExpression('review.decision == "approved"', context)).toBe(true);
  });

  it("compares booleans, numbers, and null strictly", () => {
    expect(evaluateExpression("review.metadata.retryable == false", context)).toBe(true);
    expect(evaluateExpression("review.metadata.attempts == 2", context)).toBe(true);
    expect(evaluateExpression('review.metadata.attempts == "2"', context)).toBe(false);
    expect(evaluateExpression("review.metadata.owner == null", context)).toBe(true);
  });

  it("treats a missing path as never equal to a literal", () => {
    expect(evaluateExpression('missing.status == "success"', context)).toBe(false);
    expect(evaluateExpression('missing.status != "success"', context)).toBe(true);
    expect(evaluateExpression("missing.status == null", context)).toBe(false);
  });

  it("throws on an unsupported expression instead of silently routing", () => {
    expect(() => evaluateExpression("review.status", context)).toThrow(ExpressionError);
  });
});
