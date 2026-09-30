import type { Cents } from './money.js';

/**
 * Every change to a booking's state is recorded as a DomainEvent in the EventLog, in the same call that
 * makes the change. Billing, reporting and notifications read the log, never the bookings, so a change
 * without an event (or an amount missing from its event) is one nobody downstream ever sees.
 */
export type DomainEvent =
  | { type: 'booking.requested'; bookingId: string; slotId: string; customerId: string; at: number; price: Cents }
  | { type: 'booking.confirmed'; bookingId: string; slotId: string; customerId: string; at: number }
  | { type: 'booking.cancelled'; bookingId: string; slotId: string; customerId: string; at: number; fee: Cents }
  | { type: 'booking.completed'; bookingId: string; slotId: string; customerId: string; at: number; price: Cents };

export class EventLog {
  private readonly events: DomainEvent[] = [];

  record(event: DomainEvent): void {
    this.events.push(event);
  }

  all(): readonly DomainEvent[] {
    return this.events;
  }

  ofType<T extends DomainEvent['type']>(type: T): Extract<DomainEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<DomainEvent, { type: T }> => e.type === type);
  }
}
