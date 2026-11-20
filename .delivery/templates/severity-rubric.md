# Severity Rubric

How a reviewer assigns severity. Paths in this file resolve against the skill's own
directory.

Every finding gets exactly one label. Assign it by the tests below, not by how serious the
finding feels. A reviewer who labels everything a blocker has told the coordinator nothing,
because the labels no longer separate anything.

## Criticality class

The review request declares one class for the code under review. The class sets a ceiling on
severity, because the same line of code carries different risk in different places.

| Class | What it is | Ceiling |
| --- | --- | --- |
| **C1** | Internal one-off. An engineer runs it by hand. Trusted input, no persistent data, no untrusted network. A dev script, a backfill run once, a local benchmark. | `[SHOULD-FIX]` |
| **C2** | Internal tooling that runs unattended on internal data. A CI job, a cron, an internal service. | `[BLOCKER]` only for data loss or unrecoverable state |
| **C3** | Customer-facing behavior or customer data. An app route, a public API, a UI path. | full range |
| **C4** | Security or data-integrity boundary. Auth, permissions, billing, migrations, PII, cryptography. | full range |

A finding that exceeds its class ceiling is reported at the ceiling, with one line saying it
was capped. Do not argue the class in a finding. If the class is wrong, say so once at the top
of the response and review against the declared class anyway.

## `[BLOCKER]`

All four must hold. Miss any of the first three and the finding is `[SHOULD-FIX]` at most.

1. **Trigger.** A concrete input, state, or call sequence that reaches the fault. Not "if a
   caller passed a malformed value". Name the caller, and name the value.
2. **Proof.** A failing test, an exact reproduction command, or a cited line whose behavior is
   unambiguous on reading. An argument that something *could* fail is not proof.
3. **Consequence.** One of: wrong data persisted, data lost, auth or permission bypass, secret
   exposed, migration that cannot roll back, build or CI red, a named acceptance criterion
   fails, a stated safety law breached.
4. **In scope.** Inside the paths the request declared in scope.

Fail test 4 and it is not a finding at all. It goes under *Out of scope, not flagged*.

## `[SHOULD-FIX]`

A real defect with a plausible trigger, where the consequence is not on the blocker list, or
where the proof is a reasoned argument rather than a failing test. Most genuine findings live
here. This is not a demotion.

## `[CONSIDER]`

No failure scenario. A preference, a naming point, a speculative future need, a readability
observation. One line each, unlimited count. Never blocks a merge.

## Two traps that produce bad reviews

### The hardening trap

A finding that proposes adding validation, sanitization, retries, timeouts, bounds checks, or
defensive error handling must name **the untrusted input source and the caller that can supply
it**. Without both named, the finding is `[CONSIDER]` at most.

This exists because the failure is common and expensive. An internal script's loop over a
hard-coded list does not need input validation, network retry logic, or defensive bounds
checks. Demanding them produces two hundred lines of ceremony around five lines of work, and
the coding agent complies because the finding was labelled a blocker.

### The abstraction trap

A finding whose fix introduces a wrapper, a layer, a config flag, an interface, or a new
module must say why the inline fix is insufficient. Without that, the inline fix is the
finding. A reviewer does not get to redesign the change.

## Scope and the contract

| The finding is | Disposition |
| --- | --- |
| Violates a named acceptance criterion `A<n>` | Real fault. Fix it. |
| Breaches a stated safety law | Blocker. Fix before anything else. |
| Contradicts a locked decision `D<n>` | Not a fault. Design shape is settled at plan approval. Cite the ID and reject. |
| Real defect the plan never anticipated | Judge on merits. Say whether it should have been a criterion. |
| Correct observation about excluded work | Not a finding. *Out of scope, not flagged*. |
| Already rejected in an earlier round, no new evidence | Not a finding. The request lists prior dispositions for this reason. |

One exception, and it is not a review finding: new evidence that invalidates the premise a
decision rested on is a re-baseline. It goes back to `goal-prd` and a human decides. It is
never resolved inside the review loop.

## Budget

At most **five** findings at `[BLOCKER]` and `[SHOULD-FIX]` combined, per round, ranked most
severe first. `[CONSIDER]` is unlimited at one line each.

If more than five real faults exist, the honest report is not a longer list. It is one
sentence saying the change needs a different shape, plus the five that show why. A
twenty-item list reads as noise and gets applied wholesale, which is how a review causes
overengineering instead of catching it.
