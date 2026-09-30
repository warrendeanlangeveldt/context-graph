import type { EventLog } from '../domain/events.js';
import { add, cents, type Cents } from '../domain/money.js';

/** Revenue, from the event log only: completed bookings' prices plus cancellation fees. */
export class ReportService {
  constructor(private readonly events: EventLog) {}

  revenue(): Cents {
    let total = cents(0);
    for (const e of this.events.all()) {
      if (e.type === 'booking.completed') total = add(total, e.price);
      if (e.type === 'booking.cancelled') total = add(total, e.fee);
    }
    return total;
  }
}
