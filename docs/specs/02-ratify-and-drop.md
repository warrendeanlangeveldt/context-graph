# 02. Ratify and drop

**Status:** draft
**Outcome:** The person sees each proposal with its evidence, and ratifies or drops it with a press, committed as their own act.
**Actors:** the person

## Requirements

### RAT-1 Proposals with their evidence

The pane's Proposals section lists every proposed rule and concept. Each shows its id, text, module, and evidence: decisions that served it, decisions that overrode it, and current violations of a checkable rule.

**Acceptance**

- Given a proposed rule served by 3 decisions and overridden by 1, when the section draws, then it shows "served 3, overridden 1".

### RAT-2 The band

When proposals are waiting, the band shows "N proposals to ratify" with a Context button; with none, there's no line.

**Acceptance**

- Given 2 proposals, when the prompt draws, then the band reads "2 proposals to ratify".

### RAT-3 Ratify, committed with the person's trailer

Ratify on a proposal asks for confirmation, then ratifies it and commits only the graph's files (`graph.ctx`, `proposals.ctx`, `decisions.ctx`). The commit carries `Ctx-Ratified-By: <the person's git identity>`. It refuses, committing nothing, on the repository's default branch or on a branch code-kit protects, and says why. If the person isn't among `[repo] ratifiers`, it refuses and names the setting.

**Acceptance**

- Given a proposal on a feature branch and the person among the ratifiers, when they confirm Ratify, then the rule is active and the branch has a commit of only `.ctx` files with their trailer, which `ctx gate` accepts.
- Given the current branch is `main`, when they confirm Ratify, then nothing changes and the pane says to switch to a branch.

### RAT-4 Drop

Drop on a proposal asks for a reason, then removes the proposal and records the reason as a decision by the person, so the graph remembers why it was turned down.

**Acceptance**

- Given a proposal, when the person drops it with "not how we work", then it's gone from the graph and `ctx history` on its module shows the reason.

### RAT-5 Only the person

Ratify and Drop run only on the person's press. An agent that runs the commit-and-ratify or drop command in a shell is refused by Context Graph's own hook (and code-kit's, when installed).

**Acceptance**

- Given an agent, when it runs `ctx ratify <id> --commit`, then it's refused, with "Ratifying is the person's act".

## Open questions

| Question | Owner | Blocks |
| -------- | ----- | ------ |
