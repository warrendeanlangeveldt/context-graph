import type { DomainEvent, EventLog } from '../domain/events.js';
import type { Notification, Template } from '../domain/notification.js';

const TEMPLATE: Partial<Record<DomainEvent['type'], Template>> = {
  'booking.requested': 'booking-requested',
  'booking.confirmed': 'booking-confirmed',
  'booking.cancelled': 'booking-cancelled',
};

/** Turns the event log into customer notifications, in log order. */
export class NotificationService {
  constructor(private readonly events: EventLog) {}

  outbox(): Notification[] {
    const out: Notification[] = [];
    for (const e of this.events.all()) {
      const template = TEMPLATE[e.type];
      if (template) out.push({ to: e.customerId, template, bookingId: e.bookingId });
    }
    return out;
  }
}
