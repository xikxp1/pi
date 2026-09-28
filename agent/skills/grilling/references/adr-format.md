# ADR format

ADRs live in `docs/adr/` as `NNNN-kebab-slug.md`, numbered sequentially. Scan the directory for the highest number and add one. Create the directory lazily, when the first ADR is needed.

## Template

```md
---
status: accepted
date: 2026-09-28
log: D-013
---

# Use GitHub sub-issues for ticket hierarchy

{1-3 sentences: the context, what we decided, and why.}
```

That is usually the whole ADR. The value is recording *that* a decision was made and *why*, not filling in sections.

## Optional sections

Add these only when they carry real information:

- `## Considered options`: when the rejected alternatives are worth remembering, so nobody proposes them again without the reasoning.
- `## Consequences`: when downstream effects are not obvious.

## Status

`status` is one of `proposed | accepted | deprecated | superseded by ADR-NNNN`. When a decision is replaced, write the new ADR, then change only the old ADR's `status` line. Leave its body untouched.

## What qualifies

All three must hold: hard to reverse, surprising without context, and a real trade-off. Typical examples:

- Architectural shape (process model, storage model, module boundaries)
- Integration patterns and protocol choices between components
- Technology choices with lock-in (database, auth provider, runtime, transport)
- Scope boundaries: what we explicitly will *not* do
- Deliberate deviations from the obvious path, so nobody "fixes" them later
- Constraints that aren't visible in the code (compliance, partner contracts, client limitations)

Easy-to-reverse or obvious decisions stay as log entries only.
