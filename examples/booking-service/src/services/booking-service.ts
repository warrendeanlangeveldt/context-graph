import { isActive, transition, type Booking } from '../domain/booking.js';
import type { Customer } from '../domain/customer.js';
import { DomainError } from '../domain/errors.js';
import type { EventLog } from '../domain/events.js';
import { cents, percentOf, subtract, type Cents } from '../domain/money.js';
import { minimumPrice, priceFor } from '../domain/pricing.js';
import type { BookingRepository } from '../ports/booking-repository.js';
import type { CustomerRepository } from '../ports/customer-repository.js';
import type { DiscountRepository } from '../ports/discount-repository.js';
import type { SlotRepository } from '../ports/slot-repository.js';
import type { Clock } from './clock.js';

/**
 * Use cases for bookings. Each method loads, transitions through `transition`, saves, and records the
 * event. A slot holds one confirmed booking at a time.
 */
export class BookingService {
  constructor(
    private readonly bookings: BookingRepository,
    private readonly customers: CustomerRepository,
    private readonly slots: SlotRepository,
    private readonly events: EventLog,
    private readonly clock: Clock,
    private readonly discounts: DiscountRepository,
  ) {}

  request(input: { id: string; slotId: string; customerId: string }): Booking {
    if (this.bookings.get(input.id)) throw new DomainError('VALIDATION', `booking ${input.id} already exists`);
    this.customer(input.customerId);
    const activeBookings = this.bookings.listByCustomer(input.customerId).filter(isActive);
    if (activeBookings.length >= 3) {
      throw new DomainError('LIMIT', `customer ${input.customerId} cannot exceed 3 active bookings`);
    }
    const slot = this.slots.get(input.slotId);
    if (!slot) throw new DomainError('NOT_FOUND', `no slot ${input.slotId}`);
    const booking: Booking = {
      id: input.id,
      slotId: slot.id,
      customerId: input.customerId,
      price: priceFor(slot),
      status: 'requested',
      createdAt: this.clock.now(),
      startsAt: slot.startsAt,
    };
    this.bookings.save(booking);
    this.events.record({ type: 'booking.requested', bookingId: booking.id, slotId: booking.slotId, customerId: booking.customerId, at: booking.createdAt, price: booking.price });
    return booking;
  }

  confirm(id: string): Booking {
    const booking = this.load(id);
    const taken = this.bookings.listBySlot(booking.slotId).some((b) => b.id !== id && b.status === 'confirmed');
    if (taken) throw new DomainError('SLOT_TAKEN', `slot ${booking.slotId} already has a confirmed booking`);
    const next = transition(booking, 'confirmed');
    this.bookings.save(next);
    this.events.record({ type: 'booking.confirmed', bookingId: id, slotId: next.slotId, customerId: next.customerId, at: this.clock.now() });
    return next;
  }

  cancel(id: string): { booking: Booking; fee: Cents; refund: Cents; promoted?: string } {
    const booking = this.load(id);
    const customer = this.customer(booking.customerId);
    const next = transition(booking, 'cancelled');
    let fee = cents(0);
    if (customer.kind !== 'staff' && booking.status === 'confirmed') {
      const hoursUntilStart = (booking.startsAt - this.clock.now()) / (60 * 60 * 1000);
      if (hoursUntilStart < 24) {
        fee = percentOf(booking.price, 10);
      }
    }
    const refund = subtract(booking.price, fee);
    this.bookings.save(next);
    this.events.record({ type: 'booking.cancelled', bookingId: id, slotId: next.slotId, customerId: next.customerId, at: this.clock.now(), fee });

    let promoted: string | undefined;
    if (booking.status === 'confirmed') {
      const waiting = this.bookings.listBySlot(booking.slotId).find((b) => {
        if (b.status !== 'requested') return false;
        const waitingCustomer = this.customers.get(b.customerId);
        return waitingCustomer?.status === 'active';
      });
      if (waiting) {
        const confirmed = transition(waiting, 'confirmed');
        this.bookings.save(confirmed);
        this.events.record({ type: 'booking.confirmed', bookingId: waiting.id, slotId: confirmed.slotId, customerId: confirmed.customerId, at: this.clock.now() });
        promoted = waiting.id;
      }
    }

    return { booking: next, fee, refund, promoted };
  }

  complete(id: string): Booking {
    const next = transition(this.load(id), 'completed');
    this.bookings.save(next);
    this.events.record({ type: 'booking.completed', bookingId: id, slotId: next.slotId, customerId: next.customerId, at: this.clock.now(), price: next.price });
    return next;
  }

  get(id: string): Booking {
    return this.load(id);
  }

  applyDiscount(bookingId: string, code: string): Booking {
    const booking = this.load(bookingId);
    const discount = this.discounts.get(code);
    if (!discount) throw new DomainError('NOT_FOUND', `no discount code ${code}`);
    const slot = this.slots.get(booking.slotId);
    if (!slot) throw new DomainError('NOT_FOUND', `no slot ${booking.slotId}`);
    const discountAmount = percentOf(booking.price, discount.percent);
    const newPrice = subtract(booking.price, discountAmount);
    const floor = minimumPrice(slot);
    const finalPrice = newPrice < floor ? floor : newPrice;
    const next = { ...booking, price: finalPrice };
    this.bookings.save(next);
    return next;
  }

  private customer(id: string): Customer {
    const c = this.customers.get(id);
    if (!c) throw new DomainError('NOT_FOUND', `no customer ${id}`);
    return c;
  }

  private load(id: string): Booking {
    const booking = this.bookings.get(id);
    if (!booking) throw new DomainError('NOT_FOUND', `no booking ${id}`);
    return booking;
  }
}
