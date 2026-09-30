import { describe, expect, it } from 'vitest';
import { world } from './fixtures.js';

describe('customers, notifications, reports', () => {
  it('CUST-1 registers and suspends customers, with an audit trail', () => {
    const w = world();
    expect(w.customers.suspend('c1', 'ops').status).toBe('suspended');
    expect(w.audit.all().map((a) => a.action)).toContain('customer.suspend');
  });
  it('NOTIFY-1 notifies customers in event order', () => {
    const w = world();
    w.bookings.request({ id: 'b1', slotId: 'slot-a', customerId: 'c1' });
    w.bookings.confirm('b1');
    expect(w.notifications.outbox().map((n) => n.template)).toEqual(['booking-requested', 'booking-confirmed']);
  });
  it('REPORT-1 counts completed bookings as revenue', () => {
    const w = world();
    w.bookings.request({ id: 'b1', slotId: 'slot-a', customerId: 'c1' });
    w.bookings.confirm('b1');
    w.bookings.complete('b1');
    expect(w.reports.revenue()).toBe(5000);
  });
});
