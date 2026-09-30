import { describe, expect, it } from 'vitest';
import { cents } from '../src/domain/money.js';
import { world } from './fixtures.js';

describe('bookings', () => {
  it('BOOK-1 requests a booking at the slot price and records the event', () => {
    const w = world();
    const b = w.bookings.request({ id: 'b1', slotId: 'slot-a', customerId: 'c1' });
    expect(b).toMatchObject({ status: 'requested', price: 5000 });
    expect(w.events.ofType('booking.requested')).toHaveLength(1);
  });
  it('BOOK-2 confirms one booking per slot', () => {
    const w = world();
    w.bookings.request({ id: 'b1', slotId: 'slot-a', customerId: 'c1' });
    w.bookings.request({ id: 'b2', slotId: 'slot-a', customerId: 'c2' });
    w.bookings.confirm('b1');
    expect(() => w.bookings.confirm('b2')).toThrow(/already has a confirmed booking/);
  });
  it('BOOK-3 cancels a booking and records the event', () => {
    const w = world();
    w.bookings.request({ id: 'b1', slotId: 'slot-a', customerId: 'c1' });
    expect(w.bookings.cancel('b1').booking.status).toBe('cancelled');
    expect(w.events.ofType('booking.cancelled')[0]).toMatchObject({ bookingId: 'b1', fee: 0 });
  });
  it('PRICE-1 charges 20% more for a peak slot', () => {
    const w = world();
    w.slots.create({ id: 'peak', startsAt: 200 * 3_600_000, basePrice: 1005, minimumPrice: 500, peak: true });
    expect(w.bookings.request({ id: 'b1', slotId: 'peak', customerId: 'c1' }).price).toBe(1206);
  });
  it('BOOK-4 promotes the earliest requested booking when a confirmed booking is cancelled', () => {
    const w = world();
    w.bookings.request({ id: 'b1', slotId: 'slot-a', customerId: 'c1' });
    w.bookings.request({ id: 'b2', slotId: 'slot-a', customerId: 'c2' });
    w.bookings.confirm('b1');
    const result = w.bookings.cancel('b1');
    expect(result.promoted).toBe('b2');
    expect(w.bookings.get('b2').status).toBe('confirmed');
    expect(w.events.ofType('booking.confirmed').map((e) => e.bookingId)).toContain('b2');
  });
  it('BOOK-5 skips suspended customers when promoting from the waiting list', () => {
    const w = world();
    w.bookings.request({ id: 'b1', slotId: 'slot-a', customerId: 'c1' });
    w.bookings.request({ id: 'b2', slotId: 'slot-a', customerId: 'c2' });
    w.bookings.request({ id: 'b3', slotId: 'slot-a', customerId: 'c1' });
    w.bookings.confirm('b1');
    w.customers.suspend('c2', 'test');
    const result = w.bookings.cancel('b1');
    expect(result.promoted).toBe('b3');
    expect(w.bookings.get('b3').status).toBe('confirmed');
  });
  it('DISC-1 applies a discount code to a booking', () => {
    const w = world();
    w.discounts.save({ code: 'SAVE10', percent: 10 });
    w.bookings.request({ id: 'b1', slotId: 'slot-a', customerId: 'c1' });
    const updated = w.bookings.applyDiscount('b1', 'SAVE10');
    expect(updated.price).toBe(4500);
  });
  it('DISC-2 does not discount below the slot minimum price', () => {
    const w = world();
    w.discounts.save({ code: 'SAVE95', percent: 95 });
    w.bookings.request({ id: 'b1', slotId: 'slot-a', customerId: 'c1' });
    const updated = w.bookings.applyDiscount('b1', 'SAVE95');
    expect(updated.price).toBe(2000);
  });
  it('DISC-3 throws when discount code not found', () => {
    const w = world();
    w.bookings.request({ id: 'b1', slotId: 'slot-a', customerId: 'c1' });
    expect(() => w.bookings.applyDiscount('b1', 'INVALID')).toThrow(/no discount code/);
  });
});
