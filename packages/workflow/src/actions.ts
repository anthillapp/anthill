/**
 * The reusable action library.
 *
 * An action is what a step *does*. It is stored as `config.actionKind` on an
 * `agent` node rather than as its own node type, so the graph model the future
 * runner shares stays untouched.
 *
 * Human approval is deliberately absent: it is a control block, not an action,
 * and uses the existing `approval` node type.
 *
 * Each definition carries defaults rather than fixed text. They seed a new
 * block so the author starts from something concrete, and they are plain
 * editable fields afterwards — nothing here is enforced at compile time.
 *
 * The catalog follows `docs/block-library-research.md`'s Understand / Build /
 * Verify / Deliver tables, extracted from a review of the prompts.chat corpus.
 * That review is evidence for a small, composable vocabulary of *actions* —
 * it is deliberately not turned into one block per role or profession the
 * corpus mentions ("Ethereum Developer", "Travel Guide", …). Those stay
 * Agent Profiles, prompt context, or templates.
 *
 * Two ids predate the research and keep their existing names rather than being
 * renamed to match it, because the id is persisted on every saved workflow and a
 * rename would break them for no benefit to an author:
 *   - `run-tests` is the research's "Test".
 *   - `final-action` is the research's "Final Report".
 * `brainstorm` has no counterpart in the research catalog at all — it predates
 * this proposal and the research derived its list from a prompt corpus, not
 * from this product, so its absence there is not a gap to close.
 */

export const ACTION_KINDS = [
  // Understand
  "clarify-requirements",
  "llm-consult",
  "research",
  "inspect-context",
  "extract-structure",
  "summarize",
  "decompose",
  "brainstorm",
  // Build
  "agent-step",
  "implement",
  "generate-artifact",
  "transform-rewrite",
  "design",
  "prepare-handoff",
  // Verify
  "check",
  "criteria-review",
  "llm-review",
  "adversarial-review",
  "run-tests",
  "browser-check",
  "code-review",
  "security-privacy-review",
  "accessibility-review",
  "fact-check",
  // Deliver
  "final-action",
  "present-recommendation",
  "export-package",
  "release-publish",
  "handoff-to-human",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Grouping for the palette and for telling step kinds apart on the canvas.
 * `control` covers blocks that are not actions at all (start, approval, end).
 *
 * Internal key only: `understand` was `think` until this catalog was written
 * against the research doc. `ACTION_CATEGORY_LABELS` already read "Understand"
 * before the rename — nothing user-visible changes. `category` is never
 * persisted (it is looked up from the saved `actionKind` at render time), so
 * the rename touches no saved workflow and needs no format-version bump or
 * migration.
 */
export type ActionCategory = "understand" | "build" | "verify" | "deliver";

/** Where an action shows up by default. See `docs/block-library-research.md`. */
export type ActionVisibility = "palette" | "library" | "template";

export type ActionDefinition = {
  kind: ActionKind;
  label: string;
  category: ActionCategory;
  /** One line for the palette. */
  summary: string;
  defaultPurpose: string;
  suggestedInputs: string[];
  defaultExpectedOutput: string;
  defaultSuccessCriteria: string[];
  /** How this step usually continues — rendered as guidance, not enforced. */
  typicalNextPaths: string[];
  /**
   * True when the step is meant to end in a decision that a branch reads.
   * The condition builder points at these steps first.
   */
  producesDecision: boolean;
  /**
   * The decision values this action usually returns, offered by the condition
   * builder. Suggestions only — an author may use their own vocabulary.
   */
  decisionValues?: string[];
  /**
   * Where this action shows up by default.
   *
   * `palette` — one of the 16-item MVP palette (12 actions + Start, Approval
   * Gate, Condition, End), visible without searching or expanding anything.
   * `library` — reachable by search or by expanding a category, but not shown
   * by default. Most of the catalog lives here: the palette stays compact on
   * purpose, per the research's "too many blocks" risk.
   * `template` — not offered standalone at all today; exists only as a shape
   * a template can build. No current action uses this tier — Anthill expresses
   * multi-agent shapes (Parallel Split, Merge/Synthesize) as template
   * structure over ordinary actions rather than as dedicated action kinds —
   * but the tier is here for when one is needed without another type change.
   */
  mvpVisibility: ActionVisibility;
  /**
   * Which of the eight core fields the inspector calls out as typical for this
   * action, so the author sees what usually matters here first. A hint, not a
   * requirement — every field stays editable regardless. Names match
   * `WorkflowAgentConfig`'s keys (`node-config.ts`), excluding `purpose` and
   * `task`, which apply to every action and so are never worth calling out.
   */
  suggestedFields: ("inputs" | "expectedOutput" | "successCriteria" | "constraints" | "handoff")[];
};

const DEFINITIONS: ActionDefinition[] = [
  /* ---------------------------- Understand ---------------------------- */
  {
    kind: "clarify-requirements",
    label: "Clarify Requirements",
    category: "understand",
    summary: "Resolve what is ambiguous before any work starts",
    defaultPurpose: "Find and settle the ambiguities that would derail the work later.",
    suggestedInputs: ["The request as stated", "Anything already assumed"],
    defaultExpectedOutput: "A list of resolved questions, and any that still need a human.",
    defaultSuccessCriteria: ["No requirement is left open to two readings."],
    typicalNextPaths: ["Continue once nothing is ambiguous", "Stop and ask a human"],
    producesDecision: true,
    decisionValues: ["resolved", "needs_human"],
    mvpVisibility: "palette",
    suggestedFields: ["inputs", "expectedOutput"],
  },
  {
    kind: "llm-consult",
    label: "LLM Consult",
    category: "understand",
    summary: "Ask a model for an opinion before committing to an approach",
    defaultPurpose: "Get a second opinion on an approach before building it.",
    suggestedInputs: ["The question", "Relevant code or docs"],
    defaultExpectedOutput: "A recommendation with its reasoning and trade-offs.",
    defaultSuccessCriteria: ["The recommendation names concrete trade-offs, not just a verdict."],
    typicalNextPaths: ["Continue with the recommended approach", "Consult again with a narrower question"],
    producesDecision: true,
    mvpVisibility: "palette",
    suggestedFields: ["inputs", "expectedOutput"],
  },
  {
    kind: "research",
    label: "Research",
    category: "understand",
    summary: "Gather and organize relevant information from permitted sources",
    defaultPurpose: "Find and organize the information the next step depends on.",
    suggestedInputs: ["The question to answer", "Where it is allowed to look"],
    defaultExpectedOutput: "Findings organized by question, with where each one came from.",
    defaultSuccessCriteria: [
      "Every finding names its source.",
      "Nothing important is left unanswered without saying so.",
    ],
    typicalNextPaths: ["Hand findings to LLM Consult", "Hand findings to Decompose"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["inputs", "expectedOutput"],
  },
  {
    kind: "inspect-context",
    label: "Inspect Context",
    category: "understand",
    summary: "Review project files, documents, or existing artifacts",
    defaultPurpose: "Understand what already exists before changing or adding to it.",
    suggestedInputs: ["Where to look", "What to look for"],
    defaultExpectedOutput: "A summary of what is there now, and anything that constrains the work.",
    defaultSuccessCriteria: ["The summary reflects what was actually found, not assumed."],
    typicalNextPaths: ["Continue to Decompose or Implement with the constraints in hand"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["inputs", "expectedOutput"],
  },
  {
    kind: "extract-structure",
    label: "Extract Structure",
    category: "understand",
    summary: "Pull requirements, entities, tasks, risks, or data from source material",
    defaultPurpose: "Turn unstructured source material into something the next step can act on.",
    suggestedInputs: ["The source material", "What shape the output should take"],
    defaultExpectedOutput: "Structured notes – a list, table, or outline pulled from the source.",
    defaultSuccessCriteria: ["Every item traces back to something actually in the source."],
    typicalNextPaths: ["Hand structured notes to Decompose"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["inputs", "expectedOutput"],
  },
  {
    kind: "summarize",
    label: "Summarize",
    category: "understand",
    summary: "Compress a long artifact or discussion for the next step",
    defaultPurpose: "Cut a long artifact down to what the next step actually needs.",
    suggestedInputs: ["The artifact or discussion to summarize", "What the summary is for"],
    defaultExpectedOutput: "A concise summary, short enough to hand off without re-reading the original.",
    defaultSuccessCriteria: ["Nothing the next step depends on was left out."],
    typicalNextPaths: ["Hand the summary to the next step"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["inputs", "expectedOutput"],
  },
  {
    kind: "decompose",
    label: "Decompose",
    category: "understand",
    summary: "Break approved work into ordered pieces",
    defaultPurpose: "Split the work into pieces that can be done and checked separately.",
    suggestedInputs: ["The approved approach", "Acceptance criteria"],
    defaultExpectedOutput: "An ordered list of work packages, each with its own done condition.",
    defaultSuccessCriteria: ["Every package can be verified on its own."],
    typicalNextPaths: ["Hand each package to an Agent Step"],
    producesDecision: false,
    mvpVisibility: "palette",
    suggestedFields: ["inputs", "expectedOutput", "handoff"],
  },
  {
    kind: "brainstorm",
    label: "Brainstorm",
    category: "understand",
    summary: "Open up options for an idea that is still vague",
    defaultPurpose: "Turn a vague idea into several concrete options.",
    suggestedInputs: ["The rough idea", "Known constraints"],
    defaultExpectedOutput: "Several distinct options, each with its cost and risk.",
    defaultSuccessCriteria: ["At least two genuinely different options are offered."],
    typicalNextPaths: ["Take an option to Clarify Requirements", "Take an option to Decompose"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["inputs", "expectedOutput"],
  },

  /* ------------------------------- Build ------------------------------- */
  {
    kind: "agent-step",
    label: "Agent Step",
    category: "build",
    summary: "Do the work – the general-purpose building step",
    defaultPurpose: "Carry out one piece of the work.",
    suggestedInputs: ["The work package", "Relevant files"],
    defaultExpectedOutput: "The change, plus a short note on what was done and why.",
    defaultSuccessCriteria: ["The change does what the package asked and nothing more."],
    typicalNextPaths: ["Continue to a check or review"],
    producesDecision: false,
    mvpVisibility: "palette",
    suggestedFields: ["inputs", "expectedOutput", "handoff"],
  },
  {
    kind: "implement",
    label: "Implement",
    category: "build",
    summary: "Create or modify a specific, named artifact – code, config, or content",
    defaultPurpose: "Create or modify the specific artifact this step names.",
    suggestedInputs: ["What to create or change", "Relevant files or context"],
    defaultExpectedOutput: "The changed artifact, plus a short note on what was done and why.",
    defaultSuccessCriteria: ["The change matches what this step named, and nothing more."],
    typicalNextPaths: ["Continue to a check, test, or review"],
    producesDecision: false,
    mvpVisibility: "palette",
    suggestedFields: ["inputs", "expectedOutput", "handoff"],
  },
  {
    kind: "generate-artifact",
    label: "Generate Artifact",
    category: "build",
    summary: "Draft a document, report, design, specification, or other deliverable",
    defaultPurpose: "Produce a new artifact the workflow needs.",
    suggestedInputs: ["What the artifact must cover", "Format or template to follow"],
    defaultExpectedOutput: "A new artifact meeting the stated requirements.",
    defaultSuccessCriteria: ["The artifact covers everything it was asked to cover."],
    typicalNextPaths: ["Continue to LLM Review", "Continue to Criteria Review"],
    producesDecision: false,
    mvpVisibility: "palette",
    suggestedFields: ["inputs", "expectedOutput"],
  },
  {
    kind: "transform-rewrite",
    label: "Transform / Rewrite",
    category: "build",
    summary: "Translate, convert, improve, reformat, or adapt existing content",
    defaultPurpose: "Adapt existing content into the form this step needs.",
    suggestedInputs: ["The content to transform", "The target form or standard"],
    defaultExpectedOutput: "The transformed artifact, ready for the next step.",
    defaultSuccessCriteria: ["The meaning of the original survives the transformation."],
    typicalNextPaths: ["Continue to LLM Review or Criteria Review"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["inputs", "expectedOutput"],
  },
  {
    kind: "design",
    label: "Design",
    category: "build",
    summary: "Produce a product, UX, visual, or technical design proposal",
    defaultPurpose: "Propose a design that satisfies the goal and known constraints.",
    suggestedInputs: ["The problem the design must solve", "Known constraints"],
    defaultExpectedOutput: "A design proposal with its reasoning and trade-offs.",
    defaultSuccessCriteria: ["The proposal addresses every stated constraint."],
    typicalNextPaths: ["Continue to LLM Review or an Approval Gate"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["inputs", "expectedOutput"],
  },
  {
    kind: "prepare-handoff",
    label: "Prepare Handoff",
    category: "build",
    summary: "Package context and instructions for another agent or person",
    defaultPurpose: "Package what the next agent or person needs so nothing is lost in the handoff.",
    suggestedInputs: ["What has been done so far", "Who receives it"],
    defaultExpectedOutput: "A handoff package containing the context and instructions the receiver needs.",
    defaultSuccessCriteria: ["The receiver would not need to ask a clarifying question to start."],
    typicalNextPaths: ["Continue to the receiving step"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["handoff", "expectedOutput"],
  },

  /* ------------------------------- Verify ------------------------------- */
  {
    kind: "check",
    label: "Check",
    category: "verify",
    summary: "Verify one specific property before moving on",
    defaultPurpose: "Confirm one specific thing holds before the workflow continues.",
    suggestedInputs: ["What to check", "How to check it"],
    defaultExpectedOutput: "A pass or fail, with the evidence behind it.",
    defaultSuccessCriteria: ["The result is backed by evidence, not by assertion."],
    typicalNextPaths: ["Continue on pass", "Return to the responsible step on fail"],
    producesDecision: true,
    decisionValues: ["passed", "failed"],
    mvpVisibility: "palette",
    suggestedFields: ["expectedOutput", "successCriteria"],
  },
  {
    kind: "criteria-review",
    label: "Criteria Review",
    category: "verify",
    summary: "Compare an artifact with explicit acceptance criteria",
    defaultPurpose: "Check the artifact against the acceptance criteria, one by one.",
    suggestedInputs: ["The artifact", "The acceptance criteria"],
    defaultExpectedOutput: "A pass/fail against each criterion, or a gap list.",
    defaultSuccessCriteria: ["Every criterion is addressed individually, not judged as a whole."],
    typicalNextPaths: ["Continue when every criterion passes", "Return gaps to the author"],
    producesDecision: true,
    decisionValues: ["approved", "changes_requested"],
    mvpVisibility: "library",
    suggestedFields: ["successCriteria", "expectedOutput"],
  },
  {
    kind: "llm-review",
    label: "LLM Review",
    category: "verify",
    summary: "Review the work as a careful reader would",
    defaultPurpose: "Review the change for correctness, clarity and scope.",
    suggestedInputs: ["The diff", "The acceptance criteria"],
    defaultExpectedOutput: 'A decision – "approved" or "changes_requested" – with specific issues.',
    defaultSuccessCriteria: ["Every issue names a file and says what is wrong."],
    typicalNextPaths: ["Continue when approved", "Return to the author when changes are requested"],
    producesDecision: true,
    decisionValues: ["approved", "changes_requested"],
    mvpVisibility: "palette",
    suggestedFields: ["expectedOutput", "successCriteria"],
  },
  {
    kind: "adversarial-review",
    label: "Adversarial Review",
    category: "verify",
    summary: "Actively try to break the work rather than confirm it",
    defaultPurpose: "Look for the ways this fails, not the ways it works.",
    suggestedInputs: ["The change", "The claims made about it"],
    defaultExpectedOutput: "Concrete failure scenarios, each with the input that triggers it.",
    defaultSuccessCriteria: [
      "Each finding names inputs or state that produce the wrong result.",
      "Agreement is not offered in place of scrutiny.",
    ],
    typicalNextPaths: ["Return findings to the author", "Continue when nothing survives scrutiny"],
    producesDecision: true,
    decisionValues: ["approved", "changes_requested"],
    mvpVisibility: "palette",
    suggestedFields: ["expectedOutput", "successCriteria"],
  },
  {
    kind: "run-tests",
    // Research's catalog calls this "Test". Kept as `run-tests` / "Run Tests"
    // because the id is persisted on every saved workflow already using it.
    label: "Run Tests",
    category: "verify",
    summary: "Run the suite and report what actually happened",
    defaultPurpose: "Run the test suite and report the real result.",
    suggestedInputs: ["The command to run"],
    defaultExpectedOutput: "The command output, pass/fail counts, and the names of failures.",
    defaultSuccessCriteria: [
      "The reported result matches the command output.",
      "A failing suite is reported as failing, not worked around.",
    ],
    typicalNextPaths: ["Continue when green", "Return to the author when red"],
    producesDecision: true,
    decisionValues: ["passed", "failed"],
    mvpVisibility: "palette",
    suggestedFields: ["expectedOutput", "successCriteria"],
  },
  {
    kind: "browser-check",
    label: "Browser Check",
    category: "verify",
    summary: "Look at the running interface instead of assuming",
    defaultPurpose: "Open the running app and confirm the change behaves as intended.",
    suggestedInputs: ["Where the app runs", "What to look at"],
    defaultExpectedOutput: "What was observed, including anything that looked wrong.",
    defaultSuccessCriteria: ["The observation describes what was on screen, not what was expected."],
    typicalNextPaths: ["Continue when it behaves correctly", "Return to the author otherwise"],
    producesDecision: true,
    decisionValues: ["passed", "failed"],
    mvpVisibility: "palette",
    suggestedFields: ["expectedOutput", "successCriteria"],
  },
  {
    kind: "code-review",
    label: "Code Review",
    category: "verify",
    summary: "Assess implementation quality and maintainability",
    defaultPurpose: "Review the implementation for correctness, clarity, and maintainability.",
    suggestedInputs: ["The diff", "Relevant coding standards"],
    defaultExpectedOutput: "Review comments, each naming a file and what should change.",
    defaultSuccessCriteria: ["Every comment is specific enough to act on."],
    typicalNextPaths: ["Continue when approved", "Return to the author when changes are requested"],
    producesDecision: true,
    decisionValues: ["approved", "changes_requested"],
    mvpVisibility: "library",
    suggestedFields: ["expectedOutput", "successCriteria"],
  },
  {
    kind: "security-privacy-review",
    label: "Security / Privacy Review",
    category: "verify",
    summary: "Identify security, privacy, and permission concerns",
    defaultPurpose: "Find security and privacy risks before this ships.",
    suggestedInputs: ["The change or design", "What data or permissions it touches"],
    defaultExpectedOutput: "Risk findings, each with its severity and what triggers it.",
    defaultSuccessCriteria: ["Every finding names the condition that exposes the risk."],
    typicalNextPaths: ["Continue when no material risk remains", "Return findings to the author"],
    producesDecision: true,
    decisionValues: ["approved", "changes_requested"],
    mvpVisibility: "library",
    suggestedFields: ["expectedOutput", "successCriteria"],
  },
  {
    kind: "accessibility-review",
    label: "Accessibility Review",
    category: "verify",
    summary: "Check inclusive interaction and content requirements",
    defaultPurpose: "Check that the work is usable by people relying on assistive technology.",
    suggestedInputs: ["The interface or content", "The standard to check against"],
    defaultExpectedOutput: "Accessibility findings, each naming what fails and for whom.",
    defaultSuccessCriteria: ["Every finding names the specific barrier, not a general impression."],
    typicalNextPaths: ["Continue when nothing material remains", "Return findings to the author"],
    producesDecision: true,
    decisionValues: ["approved", "changes_requested"],
    mvpVisibility: "library",
    suggestedFields: ["expectedOutput", "successCriteria"],
  },
  {
    kind: "fact-check",
    label: "Fact Check",
    category: "verify",
    summary: "Verify important claims against selected sources",
    defaultPurpose: "Confirm the claims that matter are actually true.",
    suggestedInputs: ["The claims to check", "Sources allowed to check them against"],
    defaultExpectedOutput: "Each claim marked verified or disputed, with its source.",
    defaultSuccessCriteria: ["Every claim checked has a named source, not an assertion."],
    typicalNextPaths: ["Continue when every claim is verified", "Return disputed claims to the author"],
    producesDecision: true,
    decisionValues: ["verified", "disputed"],
    mvpVisibility: "library",
    suggestedFields: ["inputs", "expectedOutput"],
  },

  /* ------------------------------- Deliver ------------------------------- */
  {
    kind: "final-action",
    // Research's catalog calls this "Final Report". Kept as `final-action` /
    // "Final Action" because the id is persisted on every saved workflow already
    // using it.
    label: "Final Action",
    category: "deliver",
    summary: "The last concrete thing to do – deliver, summarise, hand off",
    defaultPurpose: "Deliver the finished work in the form the workflow asked for.",
    suggestedInputs: ["The finished change", "The report sections required"],
    defaultExpectedOutput: "The delivered artefact and the final report.",
    defaultSuccessCriteria: ["The report covers every section the shared context asked for."],
    typicalNextPaths: ["End the workflow"],
    producesDecision: false,
    mvpVisibility: "palette",
    suggestedFields: ["expectedOutput", "handoff"],
  },
  {
    kind: "present-recommendation",
    label: "Present Recommendation",
    category: "deliver",
    summary: "Deliver an evaluated choice with trade-offs, ready for a decision",
    defaultPurpose: "Present the recommended option so a decision can be made on it.",
    suggestedInputs: ["The options considered", "Why one is recommended"],
    defaultExpectedOutput: "A decision record: the recommendation, its trade-offs, and what was ruled out.",
    defaultSuccessCriteria: ["The record states the trade-offs, not only the verdict."],
    typicalNextPaths: ["Continue to an Approval Gate"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["expectedOutput", "handoff"],
  },
  {
    kind: "export-package",
    label: "Export / Package",
    category: "deliver",
    summary: "Prepare the agreed final artifact in the required format",
    defaultPurpose: "Put the finished artifact into the exact form it needs to be delivered in.",
    suggestedInputs: ["The finished artifact", "The required format"],
    defaultExpectedOutput: "The exported deliverable, in the required format.",
    defaultSuccessCriteria: ["The export matches the required format exactly."],
    typicalNextPaths: ["Hand off, or end the workflow"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["expectedOutput", "handoff"],
  },
  {
    kind: "release-publish",
    label: "Release / Publish",
    category: "deliver",
    summary: "Describe the intended release or publication steps",
    defaultPurpose: "Describe how this should be released or published.",
    suggestedInputs: ["What is being released", "Where it goes and who needs to know"],
    defaultExpectedOutput: "A release workflow: the steps, their order, and who is told.",
    defaultSuccessCriteria: ["Every step in the release workflow says who does it."],
    typicalNextPaths: ["Hand the release workflow to a human to carry out"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["expectedOutput", "handoff"],
  },
  {
    kind: "handoff-to-human",
    label: "Handoff to Human",
    category: "deliver",
    summary: "Give a person the result and required decision context",
    defaultPurpose: "Give the responsible person what they need to decide or act next.",
    suggestedInputs: ["The result so far", "The decision or action being asked of them"],
    defaultExpectedOutput: "A human-ready handoff: the result, the ask, and anything they need to know.",
    defaultSuccessCriteria: ["The handoff states the ask plainly, not just the result."],
    typicalNextPaths: ["End the workflow", "Continue once the person responds"],
    producesDecision: false,
    mvpVisibility: "library",
    suggestedFields: ["handoff", "expectedOutput"],
  },
];

export const ACTION_LIBRARY: Record<ActionKind, ActionDefinition> = Object.fromEntries(
  DEFINITIONS.map((definition) => [definition.kind, definition]),
) as Record<ActionKind, ActionDefinition>;

export function actionDefinition(kind: ActionKind): ActionDefinition {
  return ACTION_LIBRARY[kind];
}

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === "string" && (ACTION_KINDS as readonly string[]).includes(value);
}

/** Palette order: understand, build, verify, deliver. */
export const ACTION_CATEGORY_ORDER: ActionCategory[] = ["understand", "build", "verify", "deliver"];

export const ACTION_CATEGORY_LABELS: Record<ActionCategory, string> = {
  understand: "Understand",
  build: "Build",
  verify: "Verify",
  deliver: "Deliver",
};

/** The action a new block gets when the author has not chosen one. */
export const DEFAULT_ACTION_KIND: ActionKind = "agent-step";

/** Actions shown without searching or expanding a category. */
export function paletteActions(): ActionDefinition[] {
  return DEFINITIONS.filter((definition) => definition.mvpVisibility === "palette");
}
