# Decision log format

`docs/decisions/LOG.md` is the index of **every** decision: one short entry each, grouped by grilling session. It stores the gist, not the detail. The detail of a significant decision lives in its ADR, and the log links to it.

## Template

```md
# Decision log

Index of settled decisions. Newest session last. Detail for significant decisions lives in `docs/adr/`.

## 2026-09-28: Wayfinder tracker integration

Goal: decide how wayfinder maps are stored on GitHub.

- **D-013 Ticket hierarchy**: Use GitHub sub-issues under the map issue. Why: native blocking renders the frontier in the UI. → [ADR-0007](../adr/0007-github-sub-issues-for-ticket-hierarchy.md)
- **D-014 Claiming**: The assignee is the claim; no extra label. Why: parallel sessions already filter by assignee.
- ~~**D-009 Map storage**: Local markdown file.~~ Superseded by D-015.
- **D-015 Map storage**: The map is a `wayfinder:map` issue. Why: shareable URL, team can comment. Supersedes D-009.

Open:
- Whether GitLab needs a fallback for blocking (need API check).
```

## Rules

- **IDs**: `D-NNN`, sequential across the whole file. Find the highest existing ID and add one. IDs never change and are never reused.
- **One line per decision**: `**D-NNN <title>**: <decision>. Why: <reason>.` Add ` → [ADR-NNNN](../adr/…)` when an ADR exists. Titles name the question being settled, so they read at a glance.
- **Sessions**: one `## YYYY-MM-DD: <topic>` heading per grilling session, appended at the end. Add a one-line `Goal:`. If you resume a topic on a later day, start a new heading and link the earlier one.
- **Open**: a per-session list of deferred questions and unknown facts. When a later session settles an open item, strike it through (`~~…~~ → D-NNN`) instead of deleting it.
- **Superseding**: strike through the old entry and append ` Superseded by D-NNN.` The new entry ends with ` Supersedes D-NNN.` If the old entry has an ADR, update that ADR's status too.
- **Append-only otherwise**: never reword or delete past entries. Marking them superseded is the only allowed edit.
- **No implementation detail**: file names, function signatures, and step lists belong in specs or code, not in the log.
