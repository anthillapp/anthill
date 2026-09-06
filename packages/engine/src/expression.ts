/**
 * Tiny edge-condition expression evaluator.
 *
 * Deliberately minimal — the workflow model only needs equality routing on
 * structured `AgentResult` fields:
 *
 *   review.status == "approved"
 *   review.decision != "changes_requested"
 *   gate.metadata.retryable == true
 *   review.issues.0.severity == "high"
 *
 * Grammar (whole string must match):
 *
 *   expression := path ws operator ws literal
 *   path       := segment ("." segment)*
 *   segment    := [A-Za-z_$][A-Za-z0-9_$-]*   |   [0-9]+
 *   operator   := "==" | "!="
 *   literal    := string | number | "true" | "false" | "null"
 *   string     := '"' chars '"' | "'" chars "'"      (supports \\ \" \' \n \t \r)
 *   number     := "-"? digits ("." digits)?
 *
 * Anything else (`===`, `<`, `&&`, function calls, bare identifiers on the
 * right-hand side) is rejected with an `ExpressionError`. Comparison is
 * strict: no type coercion, and a path that does not resolve yields
 * `undefined`, which is never equal to any literal (so `!=` is true for a
 * missing path).
 */

export type ComparisonOperator = "==" | "!=";

export type ExpressionLiteral = string | number | boolean | null;

export type ParsedExpression = {
  path: string[];
  operator: ComparisonOperator;
  value: ExpressionLiteral;
};

export class ExpressionError extends Error {
  readonly expression: string;

  constructor(expression: string, detail: string) {
    super(`Invalid edge condition ${JSON.stringify(expression)}: ${detail}`);
    this.name = "ExpressionError";
    this.expression = expression;
  }
}

const EXPRESSION_RE = /^\s*([^\s=!]+)\s*(==|!=)\s*(.+?)\s*$/;
const PATH_RE = /^(?:[A-Za-z_$][A-Za-z0-9_$-]*|[0-9]+)(?:\.(?:[A-Za-z_$][A-Za-z0-9_$-]*|[0-9]+))*$/;
const NUMBER_RE = /^-?[0-9]+(?:\.[0-9]+)?$/;
const DOUBLE_QUOTED_RE = /^"(?:[^"\\]|\\.)*"$/;
const SINGLE_QUOTED_RE = /^'(?:[^'\\]|\\.)*'$/;

/** Parse an expression, throwing `ExpressionError` when it is not supported. */
export function parseExpression(expression: string): ParsedExpression {
  if (typeof expression !== "string" || expression.trim() === "") {
    throw new ExpressionError(String(expression), "expression is empty");
  }

  const match = EXPRESSION_RE.exec(expression);
  if (!match) {
    throw new ExpressionError(expression, 'expected `<path> == <literal>` or `<path> != <literal>`');
  }

  const [, rawPath, rawOperator, rawLiteral] = match as unknown as [
    string,
    string,
    ComparisonOperator,
    string,
  ];

  if (!PATH_RE.test(rawPath)) {
    throw new ExpressionError(
      expression,
      `left-hand side ${JSON.stringify(rawPath)} is not a dotted property path`,
    );
  }

  return {
    path: rawPath.split("."),
    operator: rawOperator,
    value: parseLiteral(expression, rawLiteral),
  };
}

/** `true` when `parseExpression` would succeed. Useful for graph validation. */
export function isValidExpression(expression: string): boolean {
  try {
    parseExpression(expression);
    return true;
  } catch {
    return false;
  }
}

/** Read a dotted path off a context object. Returns `undefined` when absent. */
export function resolvePath(context: unknown, path: readonly string[]): unknown {
  let current: unknown = context;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object" && typeof current !== "function") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Evaluate an expression against a context object.
 *
 * The engine passes `{ [nodeId]: AgentResult }`, so `review.status` reads
 * `context.review.status`.
 *
 * @throws {ExpressionError} when the expression is not valid.
 */
export function evaluateExpression(expression: string, context: unknown): boolean {
  const parsed = parseExpression(expression);
  const actual = resolvePath(context, parsed.path);
  const equal = strictEquals(actual, parsed.value);
  return parsed.operator === "==" ? equal : !equal;
}

function strictEquals(actual: unknown, expected: ExpressionLiteral): boolean {
  // No coercion: `"5" == 5` and `undefined == null` are both false.
  return actual === expected;
}

function parseLiteral(expression: string, raw: string): ExpressionLiteral {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (NUMBER_RE.test(raw)) return Number(raw);
  if (DOUBLE_QUOTED_RE.test(raw) || SINGLE_QUOTED_RE.test(raw)) {
    return unescapeString(raw.slice(1, -1));
  }
  throw new ExpressionError(
    expression,
    `right-hand side ${JSON.stringify(raw)} is not a quoted string, number, boolean, or null`,
  );
}

function unescapeString(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char !== "\\") {
      out += char;
      continue;
    }
    i += 1;
    const next = body[i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case undefined:
        out += "\\";
        break;
      default:
        out += next;
    }
  }
  return out;
}
