# 07. Side questions

**Status:** draft
**Outcome:** The person asks the graph why something is the way it is and gets an answer beside the conversation, without interrupting the lead or filling its context.
**Actors:** the person
**Depends on:** 08-graph-explorer

## In scope

- `/why <path, module, or a question>`: answered in a side pane from the graph's slice for what it names, by a side call over the session's own context (it shares the prompt cache), never added to the conversation.
- Asked from the Context pane too, on the file or module in view.

## Requirements

### ASKQ-1 Answered beside the conversation

The answer appears in a side pane with the records it rests on (rules, decisions, cards) as links; the lead's conversation gains nothing.

**Acceptance**

- Given `/why src/billing/invoice.ts`, then a side pane explains, citing the rules and decisions on it, and the lead's next turn shows no trace of it.

### ASKQ-2 Its cost shown

Each answer shows its time and tokens.

### ASKQ-3 Only from the graph

The answer's sources are the graph's records and the files named; when the graph holds nothing on it, it says so rather than guessing.

## Open questions

| Question                                                                                                       | Owner  | Blocks |
| -------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| Whether a side call over the session's context is cheap enough to offer freely, or needs the person to opt in. | Warren | ASKQ-1 |
