import { DomainError } from './errors.js';
import type { Cents } from './money.js';

export type BookingStatus = 'requested' | 'confirmed' | 'cancelled' | 'completed';

export interface Booking {
  readonly id: string;
  readonly slotId: string;
  readonly customerId: string;
  /** Integer cents; see money.ts. */
  readonly price: Cents;
  readonly status: BookingStatus;
  /** Epoch milliseconds. Earlier requests win a slot's waiting list. */
  readonly createdAt: number;
  /** Epoch milliseconds when the booked slot begins. */
  readonly startsAt: number;
}

/** A booking holds its slot while it is requested or confirmed. */
export function isActive(b: Booking): boolean {
  return b.status === 'requested' || b.status === 'confirmed';
}

const ALLOWED: Record<BookingStatus, BookingStatus[]> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['cancelled', 'completed'],
  cancelled: [],
  completed: [],
};

/**
 * The only way a booking changes status. Bookings are immutable: this returns the next version and the
 * caller saves it. Callers record the matching DomainEvent (see events.ts) in the same operation.
 */
export function transition(booking: Booking, to: BookingStatus): Booking {
  if (!ALLOWED[booking.status].includes(to)) {
    throw new DomainError('INVALID_TRANSITION', `cannot move booking ${booking.id} from ${booking.status} to ${to}`);
  }
  return { ...booking, status: to };
}
