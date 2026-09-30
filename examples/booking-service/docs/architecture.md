# Architecture

A booking service: customers request slots, staff confirm, anyone can cancel. Customers, slots and pricing, notifications, reports and an audit trail sit alongside bookings.

## Layers

| Layer    | Folder          | May import               |
| -------- | --------------- | ------------------------ |
| domain   | `src/domain/`   | nothing outside domain   |
| ports    | `src/ports/`    | domain                   |
| services | `src/services/` | domain, ports            |
| adapters | `src/adapters/` | domain, ports            |
| api      | `src/api/`      | domain, services         |
| app      | `src/app.ts`    | everything (composition) |

`src/app.ts` is the only place adapters are constructed. Services depend on ports, never on adapters.

## Rules that span files

- **Money** is integer cents everywhere (`src/domain/money.ts`). Every percentage goes through `percentOf`, which rounds half to even; never `Math.round`.
- **Events**: every booking state change records a `DomainEvent` in the `EventLog` in the same operation (`src/domain/events.ts`). Billing, reports and notifications read only the log.
- **Status changes** go through `transition` in `src/domain/booking.ts`; nothing sets `status` directly.
- **API errors** always leave as `{ error: { code, message } }` with the `DomainError` code verbatim (`src/api/http.ts`).
