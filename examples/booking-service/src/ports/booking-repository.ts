import type { Booking } from '../domain/booking.js';

/** Where bookings live. Services depend on this port, never on an adapter. */
export interface BookingRepository {
  get(id: string): Booking | undefined;
  save(booking: Booking): void;
  /** Every booking for a slot, oldest request first. */
  listBySlot(slotId: string): Booking[];
  /** Every booking a customer has made. */
  listByCustomer(customerId: string): Booking[];
}
