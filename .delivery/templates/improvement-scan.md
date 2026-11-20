# Improvement Scan Template

```markdown
## Improvement Scan: <subject>, <date>

Goals bounding the ideal state: <source artifact(s), or "inferred: see assumptions">

### Current State (observed)
- <observation>: <evidence pointer>

### Personas
- <persona>: hires the product to <job>; today they get <observed reality>.

### Market
- <product/feature>: <capability, and whether it is table stakes or differentiator> (<source>)

### Ideal State
- <persona>: <observable experience, bounded by the goals>

### Gaps (worked backwards, ranked)
| # | Gap | Class | Persona | Evidence | Ideal-state requirement | Smallest first step |
|---|---|---|---|---|---|---|

### Recommended next item
<one gap. Why now, and which skill takes it next: goal-prd or phased-plan>

### Assumptions and open questions
- <anything the scan could not observe or verify>
```

## Gap classes

Classify every delta so the scan does not cluster on one kind of gap.

| Class | Meaning |
| --- | --- |
| Missing capability | The ideal requires something that does not exist. |
| Incomplete functionality | It exists but half-serves: works for one persona or path, fails the rest. |
| UX friction / quality debt | The capability exists but the experience leaks value: errors, latency, confusion, manual steps. |
| Parity gap | Table stakes the market has and this product lacks. |
| Differentiation opportunity | A strength no competitor matches, underexploited. |
| Discoverability gap | The product already does it, but the persona cannot find it: onboarding, docs, naming, placement. |

When the `mcp__delivery-loop__judge` tool is available, classify the deltas through it. Pass each
delta as an item and the ideal-state requirements as `context`. Ask one choice question whose
criteria are the six classes above. Classify every answer marked `review` yourself.

Each gap records the persona served, the evidence it rests on, the ideal-state requirement it
traces to, and the smallest first step that visibly moves toward the ideal.
