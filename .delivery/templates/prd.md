# PRD Template

Sections are ordered by reader intent, not by topic: the reviewer's decisions first, the shape
of the change second, the implementation contract third.

Omit a section that has nothing in it. Never keep an empty heading as a placeholder.

The first line is a provenance mark, not decoration. Keep it on every PRD and every revision.
The PR gate reads it: a plan whose `PRD.md` has no mark was written by hand, and a hand-written
PRD loses the numbered decisions and criteria that review, validation, and the PR body cite by
ID. The traceability chain then breaks silently.

## The skeleton

````markdown
<!-- delivery-loop:goal-prd -->
# <Initiative Name>

> <One sentence. The outcome, in plain words.>

**Status:** <draft | approved | in build> · **Owner:** <role, not a person> · **Updated:** <YYYY-MM-DD>

## Decide This

| ID  | Question   | Default if unanswered       | Blocking      |
| --- | ---------- | --------------------------- | ------------- |
| Q1  | <question> | <the conservative default>  | yes: <what it blocks> |
| Q2  | <question> | <the conservative default>  | no            |

## Goal

<Three to five sentences. The current failure, the target state, and why it is worth doing.>

## How It Works Today

```mermaid
%% Mandatory when the change alters an existing flow. Mark where the flow fails today.
```

## Operating Truths

| #   | Claim     | Type       | Evidence                                     |
| --- | --------- | ---------- | -------------------------------------------- |
| T1  | <claim>   | fact       | [file.ts:88](path/to/file.ts#L88)            |
| T2  | <claim>   | inference  | derived from <what>                          |
| T3  | <claim>   | assumption | verify by <how>, in <which phase>            |

## Scope

- <Included work.>

## Non-Goals

- **<Excluded work>.** <Why, in one sentence.>

## Users / Consumers

| Consumer | Use |
| -------- | --- |
| <human, service, job, agent, or downstream system> | <what they do with the output> |

## Locked Decisions

| ID  | Decision   | Consequence |
| --- | ---------- | ----------- |
| D1  | <decision> | <what it forces, and what it forbids> |

```mermaid
%% Mandatory when two or more outcomes can apply and one must win: show the precedence order.
```

## Safety Laws

- <Non-negotiable constraint. Imperative voice. No table, because these have no columns.>

## Acceptance Criteria

| ID  | Observable behavior or artifact | Proves |
| --- | ------------------------------- | ------ |
| A1  | <observable outcome>            | D4     |
| A2  | <observable outcome>            | Safety Law: <name> |

## Phased Plan

```mermaid
%% Mandatory for any phased plan: phases, dependency order, and the gates between them.
```

| Phase | Delivers | Exit | Gate |
| ----- | -------- | ---- | ---- |
| 0     | <work>   | <the observable exit condition> | <who reviews, or none> |

## Validation Plan

- <Tests, live/sandbox checks, parity checks, rollback/cleanup.>

## Risks

| Risk   | Mitigation |
| ------ | ---------- |
| <risk> | <mitigation, or the ID of the decision that handles it> |

## Accepted Risk

- **<Scenario>.** <Why it is owned rather than mitigated, and who accepted it.>

## Superseded / Removed

- **<Older assumption or mechanism>.** <Why this plan replaces it.>
````

## Decide This

This is the only section a reviewer must read, which is why it is first.

Every row carries the default that holds if nobody answers, so silence becomes a decision with
a known outcome instead of a stall. Delete a row the moment it is answered. It graduates to
Locked Decisions.

This is the document's only list of unresolved questions. Never also keep an `Open Questions`
section further down. Two lists of the same questions drift apart.

Cap: 200 words.

## Operating Truths

Every row carries its own evidence pointer. A row with an empty evidence cell is not an
operating truth: delete it, or demote it to a `Decide This` row.

`Type` is one of `fact`, `inference`, or `assumption`. An assumption names how and when it gets
verified.

## Diagrams

A diagram earns its place when the underlying logic is a graph. Prose is the wrong encoding for
a branch, an ordering, or a gate: the reader rebuilds the graph in their head, and different
readers rebuild it differently.

Four shapes are graphs. Diagram each one the document contains.

| Shape | Present when | Mermaid |
| --- | --- | --- |
| Flow with a defect | The change alters an existing pipeline or flow | `flowchart LR`, failing edge marked |
| Precedence lattice | Two or more outputs can apply and exactly one must win | `flowchart TB` in priority order |
| Multi-signal gate | An assertion requires N of M conditions | `flowchart TD`, with the partial-match branch |
| Phase dependency | Any phased plan | `flowchart LR`, gate nodes between phases |

Diagram nothing else. A list, a table, a schema, or a boxes-and-arrows overview that no decision
depends on costs review attention and earns nothing. If you cannot name the decision a diagram
supports, delete it.

Label the edges that carry a condition. Keep node text under about six words. Never encode a
fact that appears nowhere else. A diagram summarizes the text. It is not the only home for a
requirement.

## IDs

- Operating Truths `T<n>`, Locked Decisions `D<n>`, questions `Q<n>`, Acceptance Criteria `A<n>`.
- IDs are stable and never renumbered. A superseded decision keeps its ID and moves to
  `Superseded / Removed`. That is how a later reader knows what `D4` meant.
- Every Acceptance Criterion names what it proves: a decision ID, a safety law, or a named
  regression floor.
- Every behavior-changing Locked Decision has at least one criterion proving it. A decision with
  no criterion is untestable or unnecessary. Say which.
