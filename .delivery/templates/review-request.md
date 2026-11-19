# Review Request Template

Fill every field. A reviewer starting a cycle is a fresh session with no history: it knows
nothing this document does not say. On a later round the same session reads the updated
request, so change only the round number, the diff, and the dispositions. A blank field is not neutral. It is where the reviewer invents its own
scope and reviews something else.

Copy the block below, fill it, and hand it over with `severity-rubric.md` and
`review-response.md`. Resolve both the way the skill resolves this file: a project copy at
`.delivery/templates/<same-name>` wins when it exists, otherwise the copy in this directory.

---

```markdown
# Review request: <change name>, round <N>

You are a rigorous, skeptical reviewer. The author expects to have missed things.
Read the rubric before you start. Return the response template, filled.

Perspective:  <security | code quality | test adequacy | data integrity | ...>
Session:      <name and ID. Keep this session for every round of this cycle>

Judge the diff against the proposed fix and the application vision. Check completeness,
quality, and sanity. Ask for minor changes. Request larger work only for a major miss in the
requirements or missing functionality. Approve when the objectives are met.

## Get the code

Repository:   <path or URL>
Branch:       <branch>
Worktree:     <absolute path. Work here, do not touch any other checkout>
Base:         <base branch or sha>

The diff under review, exactly:

    <the diff command, e.g. git diff origin/main...HEAD -- src/ lib/>

## Build and test it

These commands work in the worktree above. Run them before judging anything.

    <install command, e.g. bun install>
    <test command, e.g. bun test src/thing>
    <lint/typecheck command>

<Anything needed to make them work: env vars, fixtures, a running service, a seeded database.
If the suite cannot run, say so in your response. Do not review blind and stay quiet about it.>

## What this change is for

<Two or three sentences. The outcome, in plain words.>

## The contract

Plan:         <path to PRD.md, or "none">
In scope IDs: <acceptance criteria and decisions this change must satisfy, e.g. A4-A6, D5>

The plan's Locked Decisions and Acceptance Criteria are numbered. Cite those IDs. Read
Non-Goals and Accepted Risk before proposing anything: work the plan deliberately excluded is
not a finding.

## Criticality class

Class: <C1 | C2 | C3 | C4>
Why:   <one sentence: who runs this, on what data, reachable by whom>

The class caps severity. The rubric says how.

## In scope: these exact paths

- `<path>`: <what it does>
- `<path>`: <what it does>

Changed lines and the code directly affected by them. Pre-existing code only where the diff
depends on it, makes it newly risky, or exposes a concrete latent bug.

## Out of scope: do not review

- `<path>`: <why it is excluded: reviewed in its own PR, generated, vendored, unchanged>
- <Topic: e.g. the retry policy, settled in D7. The logging format. Test naming.>

## Focus: answer these, ranked

1. <The most specific question you want answered.>
2. <The second.>
3. <The third, optional.>

## Attention items

- `<file>:<line>`: <what to look at and why it might be wrong>
- `<file>:<line>`: <what to look at and why>

## How this can realistically fail

- <Failure mode that actually applies to this code.>

Kill criterion: <the one outcome that must not be possible. Silent false pass, data loss,
auth bypass, broken migration.>

## Already dispositioned: do not raise again

<Findings from earlier rounds and how they were dispositioned. Re-raising one without new
evidence is not a finding. Omit this section on round 1.>

| Round | Finding | Disposition | Why |
| --- | --- | --- | --- |
| 1 | <summary> | REJECTED | <the guard that covers it, or the decision ID it contradicts> |

## Constraints

- Do not edit files. Report only.
- Stay inside the declared scope. Observations outside it go in the response section for them.
- No production access. Non-prod and read-only if you touch anything live at all.
- Five findings maximum at BLOCKER and SHOULD-FIX combined. CONSIDER is unlimited, one line each.
- Every BLOCKER needs a failing test or an exact reproduction command. No proof, no blocker.

## Return

Fill `review-response.md` and return it. Nothing else.
```
