---
name: status
description: Where Context Graph stands in this repository. Whether it is wired and working, whether the graph is valid, how many files have current cards, what the last session covered and still owes, and what to do about anything wrong. Use when the person asks whether ctx or Context Graph is working, what it holds, how well the last session built its context, or when ctx next reports a broken setup.
---

# Context Graph status

The CLI is `ctx`. Run these from the repository root:

```bash
ctx doctor        # every link in the chain: graph, instruction block, plugin version, hooks firing
ctx check         # the graph is valid
ctx cards         # files with current, stale and missing cards
ctx coverage      # the last session: each edit, whether its slice arrived, callers in context
ctx pending       # decisions the last session still owes
```

## Report

Lead with the answer, in a few lines:
1. **Working or not.** If `doctor` fails, name the broken link and its fix:
   - no graph: the `init` skill;
   - the instruction block is missing: `ctx install instructions`;
   - the hooks aren't firing: sessions started before the plugin was installed or updated never loaded them. Trust them with `/hooks`, then start a new session;
   - the plugin is older than the source: update it.
   - `ctx` isn't on the PATH: `ctx install cli`, or `npm i -g context-graph`.
2. **Validity.** For any `check` errors, say what each means and how to fix it.
3. **What it holds:** modules, rules (how many still proposed), decisions, and cards (current, stale, missing).
4. **The last session:**
   - edits made with no slice;
   - edits made with none of the file's callers in context;
   - anything still owed.

Then one line on what to do next. Usually that's the `next` skill, which picks it for you.

Give the full command output only if the person asks.
