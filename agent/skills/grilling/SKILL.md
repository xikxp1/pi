---
name: grilling
description: Grill the user relentlessly about a plan, design, or idea until you share an understanding, recording every settled decision in docs/decisions/LOG.md and significant ones as ADRs in docs/adr/. Use when the user wants to stress-test their thinking, says "grill me", or asks to settle a design before implementing.
---

# Grilling

Interview the user relentlessly until you reach a shared understanding, and write every decision down as it is made. You plan; you do not implement. Nothing gets built until the user confirms the shared understanding.

Adapted from mattpocock/skills (`grilling` + `domain-modeling`), MIT.

## 1. Load prior decisions

Before the first round:

1. Find the log root: the repository root (`git rev-parse --show-toplevel`), else the working directory. If the project's `AGENTS.md` names another decision-log or ADR location, use that instead.
2. Read `docs/decisions/LOG.md` if it exists. List `docs/adr/` and read only the titles, plus the full text of any ADR relevant to the topic.
3. Treat active (not superseded) decisions as settled. Don't ask about them again. If the user's plan contradicts one, raise that as a question: "LOG D-012 says X, but you're proposing Y. Supersede it?"

## 2. Design tree and rounds

Model the topic as a **design tree**: every decision branches into the decisions that depend on it. The **frontier** is every open decision whose prerequisites are already settled, meaning you can ask it now without guessing at answers you haven't heard yet.

Work in **rounds**. Each round asks the whole frontier, numbered, with your recommended answer for each. Then stop and wait for the user's answers. A question that depends on another question open in the same round belongs in a later round.

```
❓ **Q1 - <short title>**: <the question; list options as a/b/c when they exist>

➡️ <recommended answer + one-line why>

---

❓ **Q2 - ...
```

Keep each question short, a few lines at most. Long questions tire the user out and hide why you're asking. If only one crisp multiple-choice question is on the frontier, you may use the `ask_user` tool instead.

**Facts are your job; decisions are the user's.** Never ask the user something you can look up in the code, docs, tools, or web. Resolve facts before posting the round, using `read`/`ffgrep`/`fffind` directly or parallel `subagent` calls for bigger investigations. Subagents don't see this conversation, so give them full context and a concrete question. If a lookup would take long, ask the independent questions now and hold back only the ones that depend on it. Never answer a decision on the user's behalf.

After each answer, recompute the tree. Settled decisions push the frontier outward. New answers can also reopen or invalidate earlier branches: say so explicitly.

## 3. Record decisions immediately

After every round the user answers, **before** posting the next round, write the settled decisions down. Don't batch them to the end. Formats are in [references/log-format.md](references/log-format.md) and [references/adr-format.md](references/adr-format.md).

- **Every** settled decision gets one entry in `docs/decisions/LOG.md`, under this session's heading.
- A decision **also** gets an ADR only if all three are true:
  1. **Hard to reverse**: changing your mind later costs something real.
  2. **Surprising without context**: a future reader would wonder "why did they do it this way?"
  3. **A real trade-off**: there were genuine alternatives, chosen between for specific reasons.

  Write the ADR, link it from the log entry, and mention it in your next message so the user can veto it.
- Answers like "you decide" or "go with your recommendation" count as decisions; record them. Questions the user defers go in the session's **Open** list, not in the decisions.
- When a decision replaces an earlier one, mark the old entry and the old ADR as superseded (see the formats). Never silently rewrite history.
- Create files and directories lazily, only when there is something to write.

Start each message after recording with one line saying what was logged, e.g. `📝 Logged D-014, D-015 (ADR-0007)`.

## 4. Finish

The session is done when the frontier is empty: every branch visited, nothing silently assumed. Then:

1. Make sure the session's **Open** list in the log is accurate (deferred questions, facts still unknown).
2. Post a short recap: the decisions (by title, with IDs), the ADRs written, and the open items.
3. Ask the user to confirm the shared understanding. Do not act on the plan (write code, create tickets) until they confirm and ask for it.

If the user ends early, still update the Open list with the unvisited frontier so the next session can resume from the log.
