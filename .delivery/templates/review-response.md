# Review Response Template

What the reviewer returns. The coordinator marks up the `Disposition` column and the result
becomes the PR body's disposition table with no retyping.

Every field is required. "None" is a valid and useful answer.

---

```markdown
# Review response: <change name>, round <N>

## Did the suite run?

Commands run:   <the test/lint commands you actually ran>
Result:         <pass | fail | could not run>
If it could not run: <what was missing. Say this plainly. A review of code you could not
execute is weaker, and the coordinator needs to know which kind of review this is.>

## Verdict

<One sentence: either the specific fault that matters most, or a statement that the
implementation is correct within the declared scope. Not a summary of the change.>

Findings: <N> BLOCKER · <N> SHOULD-FIX · <N> CONSIDER

## Findings

Ranked most severe first. Five maximum at BLOCKER and SHOULD-FIX combined.

### F1 · [BLOCKER|SHOULD-FIX|CONSIDER] · <one-line claim>

| | |
| --- | --- |
| **Location** | `<file>:<line>` |
| **Contract tag** | <Violates A4 \| Breaches safety law "<name>" \| Contradicts D5 \| Gap, no ID \| Out of scope> |
| **Trigger** | <the concrete input, state, or call sequence that reaches it> |
| **Consequence** | <what goes wrong, specifically> |
| **Proof** | <failing test, exact repro command, or the cited line and why it is unambiguous> |
| **Capped by class** | <yes, from BLOCKER to SHOULD-FIX because class is C1 \| no> |
| **Disposition** | <coordinator fills: FIXED / REJECTED / DEFERRED + reason> |

Failing test or reproduction:

    <the actual command and its actual output, or the test source>

Smallest fix that resolves it:

<The inline fix. If it needs a new wrapper, layer, flag, or module, say why the inline fix is
insufficient. Otherwise the inline fix is the finding.>

### F2 · ...

## CONSIDER: one line each

- <observation>: `<file>:<line>`

## Out of scope, not flagged

<Real things you noticed that the request excluded. Listing them here proves you saw them
without turning them into work.>

- <observation>: `<file>:<line>`, excluded by <which exclusion covers it>

## Deliberately not flagged

<Things that look like faults and are not, with why. This is the most useful section in the
document: it tells the coordinator you understood the design instead of pattern-matching it.>

- <thing>: <why it is correct here>

## What I could not judge

<Surface you could not reach: no credentials, no fixture, generated code, a service you could
not run. Say it rather than guessing.>

- <surface>: <what would let you judge it>
```

---

## Marking it up

The coordinator fills each `Disposition` cell and nothing else:

- **FIXED**: the commit that carries the fix, plus the command that proves the regression is
  gone. A code surface without a commit is not a disposition.
- **REJECTED**: the guard that already covers it, or the decision ID whose agreed behavior the
  fix would remove. A finding against plan-agreed functionality is always REJECTED, citing the ID.
- **DEFERRED**: the owner or the condition. Never as a way to avoid saying no.

A table that is 100% FIXED deserves a second look. It usually means findings were applied
instead of judged.
