import { describe, expect, it } from 'vitest';
import { world } from './fixtures.js';

describe('http', () => {
  it('API-1 creates and confirms a booking', () => {
    const w = world();
    expect(w.http({ method: 'POST', path: '/bookings', body: { id: 'b1', slotId: 'slot-a', customerId: 'c1' } }).status).toBe(201);
    expect(w.http({ method: 'POST', path: '/bookings/b1/confirm' })).toMatchObject({ status: 200, body: { booking: { status: 'confirmed' } } });
  });
  it('API-2 returns errors in one shape', () => {
    const w = world();
    expect(w.http({ method: 'GET', path: '/bookings/nope' })).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'no booking nope' } } });
  });
  it('API-3 cancels a confirmed booking and returns the result', () => {
    const w = world();
    w.http({ method: 'POST', path: '/bookings', body: { id: 'b1', slotId: 'slot-a', customerId: 'c1' } });
    w.http({ method: 'POST', path: '/bookings/b1/confirm' });
    const response = w.http({ method: 'POST', path: '/bookings/b1/cancel' });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      booking: { id: 'b1', status: 'cancelled' },
      fee: 0,
      refund: expect.any(Number),
      promoted: undefined,
    });
  });
});
