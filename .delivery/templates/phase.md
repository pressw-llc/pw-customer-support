# Phase Template

One block per phase. Every field is required. A blank field is where a phase quietly loses its
exit condition.

```markdown
### Phase N: <Name>

**Objective:** <What becomes true.>
**Proves:** <PRD criteria and decisions this phase satisfies, by ID: A1, A4-A6, D5.
  `none: scaffolding` is a valid answer that must be stated, never left blank.>
**Inputs:** <Code, docs, credentials, schemas, fixtures, decisions.>
**Work:** <Concrete implementation or discovery tasks.>
**Dependencies / Blockers:** <Only real blockers.>
**Exit Criteria:** <Observable conditions that end the phase. Cite a PRD criterion by ID
  rather than restating it.>
**Validation:** <Automated, live, parity, or manual checks. Name which criterion each proves.>
**Review Gate:** <User review, code review, adversarial review, or PR milestone.>
**Fan-out Budget:** <none (default, single agent) | N agents / R rounds, justified by:
  <expected marginal value>>
**Rollback / Safety:** <How to back out, or how production stays safe.>
**Decommission / Cleanup:** <What is removed, retired, or marked superseded before this
  phase can close.>
```

## Document-level sections

A standalone plan carries `## Decide This` for anything the user must decide and
`## Accepted Risk` for risks owned rather than mitigated.

When the plan pairs with a PRD, both live in the PRD and the plan references them by ID. Never
duplicate them: two copies drift.

A paired plan opens with the phase dependency diagram, the same one the PRD's `Phased Plan`
section carries. One diagram, referenced from both, never two that can disagree.

## The coverage check

Every acceptance criterion belongs to exactly one phase. This is the most useful thing the
pairing buys.

| Symptom | What it means |
| --- | --- |
| A criterion claimed by no phase | Unbuilt work nobody noticed. A phase is missing, or the criterion was aspirational. Say which. |
| A criterion claimed by two phases | The phase boundary is wrong, or the criterion is really two. |
| A phase proving no criterion | Scaffolding to fold into its neighbour, or work the PRD never asked for. |

Run it when the plan is drafted and again at every phase exit. Report counts, not prose:
`criteria: 12 total, 12 claimed, 0 orphaned`.
