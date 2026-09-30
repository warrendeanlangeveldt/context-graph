# Example: a booking service, built by an agent under Context Graph

A real graph, with the code it describes. Claude Haiku 4.5 built this booking service over six tasks, running Context Graph 0.2.1 with its context loop on. It's run 3 of the `ctx 0.2.1` arm in the `ctx-bench-lab` benchmark, round 2: the best of that arm's runs, with 20 of 23 hidden checks passed.

## What's in `.ctx/`

- **`graph.ctx`:** modules per layer, four concepts, and six rules: half-even money rounding, every state change recorded as an event carrying the amounts downstream needs, status only through `transition()`, services depending on ports, one API error shape, and only `app.ts` building adapters.
- **`decisions.ctx`:** 16 decisions.
  - `d-0001` to `d-0009` are the starting context, recorded by people: `lead`, `ops`, `fraud`, `finance`, `support`. Six of them are rules that appear nowhere in the code or docs: staff never pay a cancellation fee, suspended customers are skipped on the waiting list, cancellations are logged before promotions, discounts stop at a slot's minimum price, cancelling over HTTP answers 202, and customer ids are case-insensitive.
  - The other seven were recorded by the agent as it worked, each saying what it changed and which rule or decision it honoured.
- **`cards.ctx`:** the file cards the agent wrote after its edits: what each file is for, what it relies on, who relies on it, and what it must keep true. The latest card for a file is the one in force.

## Try it

The example is a snapshot, not its own repository, so copy it out first:

```sh
cp -R examples/booking-service /tmp/booking && cd /tmp/booking && git init -q && git add -A && git commit -qm example
ctx check                                   # the graph is valid
ctx why src/services/booking-service.ts     # its card, its rule, and the agent's decisions citing d-0004 and d-0007
ctx cards                                   # which files have a card matching them
ctx next                                    # what Context Graph would ask for next here
npm install && npm test                     # the code builds and its own tests pass
```

`ctx why src/services/booking-service.ts` shows what the loop is for. The agent's card and decisions name the staff-fee rule (`d-0004`) and the discount floor (`d-0007`), which it could only have learned from the graph. They reached it before the edit, through what the service imports.

## What it got wrong

This isn't a model answer. The run missed three hidden checks:
- **The refund isn't on the cancellation event,** so billing, which reads only the event log, never sees it. The rule is stated in `events.ts` and in decision `d-0002`.
- **Applying a discount isn't recorded as an event.**
- **Customer ids aren't compared case-insensitively when counting a customer's bookings** (`d-0009`). The decision was shown to the agent before the edit, and it didn't apply it.

The first two are rules stated in the code; the third is recorded only in the graph. All three were in front of the agent. What's left to improve is getting a model to apply what it was shown, not getting the context to it.
