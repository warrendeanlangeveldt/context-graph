import type { Booking } from '../domain/booking.js';
import type { BookingRepository } from '../ports/booking-repository.js';

export class MemoryBookingRepository implements BookingRepository {
  private readonly bookings = new Map<string, Booking>();

  get(id: string): Booking | undefined {
    return this.bookings.get(id);
  }

  save(booking: Booking): void {
    this.bookings.set(booking.id, booking);
  }

  listBySlot(slotId: string): Booking[] {
    return [...this.bookings.values()].filter((b) => b.slotId === slotId).sort((a, b) => a.createdAt - b.createdAt);
  }

  listByCustomer(customerId: string): Booking[] {
    return [...this.bookings.values()].filter((b) => b.customerId === customerId);
  }
}
