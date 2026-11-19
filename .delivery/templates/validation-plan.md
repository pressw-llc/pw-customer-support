# Validation Plan Template

Two fillable blocks. Write the plan before running it; report against the criteria after.

## The plan

```markdown
## Validation Plan

Target environment: <local sandbox | staging | local real services | non-prod tenant>
Criteria under test: <PRD acceptance criteria by ID, e.g. A1-A6, A11>
Preconditions: <credentials, env vars, seeded data, running services>
Path exercised: <end-to-end workflow>
Commands / steps:
1. <command or UI path>
2. <command or UI path>
Expected result:
- <observable outcome, and the criterion ID it proves>
Safety:
- <read-only, sandbox write, rollback, cleanup>
Evidence to capture:
- <logs, IDs, counts, diff, screenshot>
```

## The criteria report

The unit of proof is the criterion, not the command. A green test run that exercises no named
criterion has told you the suite passes, not that the work is done.

```text
A1  PASS     <evidence: quoted line from file, record id, or screenshot>
A2  PASS     <evidence>
A3  FAIL     <what happened instead>
A4  NOT RUN  <why, and what would unblock it>

12 criteria: 10 pass, 1 fail, 1 not run
```

Three rules make it honest.

- **`NOT RUN` is a valid outcome and must be stated.** A criterion silently missing reads as
  passing. Name what stopped it: credentials, environment, a blocked dependency.
- **Every criterion appears.** The counts close the loop.
- **A safety law never reports `NOT RUN` on the run that closes a phase.** Those are the
  constraints the work may not violate. If one cannot be exercised, the phase does not exit.
