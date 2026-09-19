# The workflow document

What `create_workflow_draft` accepts. Anthill validates a handover with the same
rules its own editor uses, so a document that misses these comes back as a
refusal carrying the questions rather than as a diagram.

## The whole shape

```json
{
  "id": "workflow-checkout-rework",
  "name": "Checkout rework",
  "version": "0.1.0",
  "target": "claude-code",
  "brief": {
    "goal": "Card declines are retried once and the user is told what happened.",
    "context": "apps/web/src/checkout; the retry policy is new, the payment client is not.",
    "doneCriteria": [
      "A declined charge is retried exactly once before the user is told.",
      "The failure message names the reason the gateway gave."
    ],
    "constraints": ["Do not change the payment client's public interface."],
    "verification": "The new tests in checkout.test.ts pass, and the existing suite still does."
  },
  "nodes": [
    { "id": "start", "type": "start", "name": "Start", "config": {} },
    {
      "id": "n1", "type": "agent", "name": "Read the checkout path", "config": {
        "actionKind": "inspect-context",
        "agentId": "agent-1",
        "task": "Read apps/web/src/checkout and the payment client, and write down where a decline surfaces today.",
        "expectedOutput": "A note naming every place a decline is handled, with file and line.",
        "successCriteria": ["Every decline path in the directory is accounted for."]
      }
    },
    {
      "id": "n2", "type": "agent", "name": "Implement the retry", "config": {
        "actionKind": "implement",
        "agentId": "agent-1",
        "task": "Retry a declined charge once, then surface the gateway's reason to the user.",
        "expectedOutput": "The change, with tests covering a retry that succeeds and one that does not.",
        "successCriteria": ["A declined charge is retried exactly once.", "The message names the gateway's reason."]
      }
    },
    {
      "id": "n3", "type": "agent", "name": "Review the change", "config": {
        "actionKind": "code-review",
        "agentId": "agent-2",
        "task": "Review the retry against the done criteria and say whether it holds.",
        "expectedOutput": "A decision of approved or changes_requested, with specific issues.",
        "successCriteria": ["Every done criterion is addressed explicitly."],
        "maxIterations": 3
      }
    },
    { "id": "end", "type": "end", "name": "Done", "config": {} }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "n1" },
    { "id": "e2", "source": "n1", "target": "n2" },
    { "id": "e3", "source": "n2", "target": "n3" },
    { "id": "e4", "source": "n3", "target": "end" },
    { "id": "e5", "source": "n3", "target": "n2", "kind": "rework",
      "condition": "reviewer.decision == \"changes_requested\"", "label": "Changes requested" }
  ],
  "metadata": {
    "workflow": {
      "formatVersion": 5,
      "agents": [
        { "id": "agent-1", "name": "Developer", "role": "Reads the code and makes the change" },
        { "id": "agent-2", "name": "Reviewer", "role": "Checks the change against the criteria" }
      ]
    }
  }
}
```

`formatVersion` must be **5**. A legacy or future format is refused, not migrated.

## Ids

Every block id matches `[A-Za-z0-9_.:-]+` — letters, digits, `_`, `.`, `:`, `-`,
and nothing else. No spaces. They are printed into progress commands verbatim
(`anthill step <run> <nonce> <block-id>`), which is why the class is narrow.

Ids must be unique among blocks, among edges, and among agents. They are also
what the user sees the work reported against, so `n1` is fine but a name that
says something is kinder.

## Blocks

Four types, and no others: `start`, `agent`, `approval`, `end`. Exactly one
`start`; at least one `end`. `condition` and `command` exist in the schema but
are not supported in a workflow and are refused.

An **agent** block's `config`:

| field | required | what it is |
| --- | --- | --- |
| `actionKind` | yes | What kind of work this is. One of the 29 below. |
| `agentId` | yes | The agent carrying it out — an `id` from `metadata.workflow.agents`. |
| `task` | yes | What this step must do. An empty task compiles to an empty instruction. |
| `expectedOutput` | advised | What it must produce. Its absence is a warning, not a refusal. |
| `successCriteria` | advised | How to tell it succeeded. Same. |
| `purpose` | no | Why the step exists, in a line. |
| `inputs` | no | What it needs before it can start. |
| `constraints` | no | Limits for this step only; workflow-wide ones go in the brief. |
| `handoff` | no | What to pass on, and to whom. |
| `maxIterations` | **on a loop** | How many passes are allowed. Required for every agent block on a cycle. |

An **approval** block's `config` takes `prompt` — the question put to the person
approving. `start` and `end` take an empty `config`.

### Action kinds

```
clarify-requirements  llm-consult      research           inspect-context
extract-structure     summarize        decompose          brainstorm
agent-step            implement        generate-artifact  transform-rewrite
design                prepare-handoff  check              criteria-review
llm-review            adversarial-review  run-tests       browser-check
code-review           security-privacy-review  accessibility-review
fact-check            final-action     present-recommendation
export-package        release-publish  handoff-to-human
```

`agent-step` is the honest fallback when nothing else fits.

## Connections

`{ id, source, target }` at minimum. `kind` is `next` (the default), `rework`,
`question` or `stop`. `label` is what the user reads on the line.

* Every block except `end` needs a way out. A block with no outgoing connection
  is a dead end and is refused.
* Every block must be reachable from `start`.
* **A block with two or more outgoing connections where every one carries a
  condition is refused.** Leave one unconditional as the fallback.
* A condition reads `<agent-slug>.<field> == "value"` — `==` or `!=`, and a
  quoted string, number, `true` or `false`. The first segment is the agent's
  name lowercased with non-alphanumerics collapsed to hyphens, so an agent named
  "Reviewer" is `reviewer`.

## Loops

A cycle is allowed and is how rework is expressed: a `rework` edge from a review
block back to the one before it. Two things are then required, and a loop
without either is refused:

* `maxIterations` on **every** agent block on the cycle, and
* at least one item in `brief.doneCriteria` — an attempt limit says when to give
  up, which is not the same as saying when the work is finished.

## The brief

`goal` and `doneCriteria` are required for a handover: Anthill refuses one that
names no goal or says nothing about what done looks like, because neither the
user nor a reviewer can judge it. `context`, `constraints`, `assumptions`,
`verification`, `prohibitedActions`, `finalAction` and `report` are optional and
are worth filling when the user has said something about them.

## Agents

`metadata.workflow.agents` is a list of `{ id, name }`, optionally `role` and
`description`. A block points at one by `config.agentId` and carries no name or
model of its own, so renaming an agent cannot split it and two steps cannot
disagree about what it is.

Two agents may not share a name once slugified, and a nameless agent is refused —
the slug is what a condition reads and what a generated agent file is called.

Give agents the roles the work actually has. Three steps all carried out by one
"Assistant" is a diagram of nothing.

## Limits

1 MB of JSON, 1,000 blocks, 5,000 connections, 64 levels of nesting. `target`
must be `claude-code` when Claude Code is the one submitting: a workflow
targeting another tool describes a prompt for something else.
