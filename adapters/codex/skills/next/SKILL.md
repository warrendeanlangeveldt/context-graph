---
name: next
description: The one command for Context Graph. Reads where the repository stands (no graph yet, a broken setup, cards or decisions owed, changed files without cards, proposals waiting for a person) and runs the right Context Graph skill, carrying on until a person is needed. Use when the person asks what to do next with Context Graph or ctx, or is new to it and doesn't know where to start.
---

# Next step

The CLI is `ctx` (`ctx install codex` puts it on the path). Run it from the repository root.

## 1. Read the state

```bash
ctx next --json
```

It returns `step`, `why`, a `command` that does it directly when one suffices, `attention` (things the person should know) and a `summary` when there's nothing to do. The order it checks:

| State | Step |
| --- | --- |
| No graph for this repository | `init` |
| The graph has errors, or the setup is broken (`ctx doctor` fails) | `status` |
| The last session still owes decisions or cards | `cards` |
| AGENTS.md or CLAUDE.md lacks the Context Graph block | `init` (just `ctx install instructions`) |
| Files this branch changed have no card matching them | `cards` |
| Proposed rules wait for ratification, or hygiene proposes changes | `curate` |
| None of that | done: say so, with the summary |

Tell the person in one or two lines what you found and what you're about to do.

## 2. Run it

Use the Context Graph skill the step names (`next`, `init`, `cards`, `curate` or `status`), and follow it in full. When `command` alone does the job, as `ctx install instructions` does, run it instead. This skill only chooses; it never does a step's work itself.

## 3. Keep going until the person is needed

After a step, run `next --json` again and carry on without asking, as long as nothing needs the person. Stop and hand over when:
- a skill needs the person's decision: which proposals to ratify, what a rule should say, whether to adopt a linked graph;
- a person has to act: commit with a `Ctx-Ratified-By` trailer, trust updated hooks with `/hooks`;
- the step is done;
- the same step comes back twice with nothing changed. Report what's stuck instead of looping.

End with one line saying what happens next and who does it.
