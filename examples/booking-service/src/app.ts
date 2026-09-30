import { MemoryBookingRepository } from './adapters/memory-booking-repository.js';
import { MemoryCustomerRepository } from './adapters/memory-customer-repository.js';
import { MemoryDiscountRepository } from './adapters/memory-discount-repository.js';
import { MemorySlotRepository } from './adapters/memory-slot-repository.js';
import { createHttp } from './api/http.js';
import { AuditLog } from './domain/audit.js';
import { EventLog } from './domain/events.js';
import { BookingService } from './services/booking-service.js';
import type { Clock } from './services/clock.js';
import { CustomerService } from './services/customer-service.js';
import { NotificationService } from './services/notification-service.js';
import { ReportService } from './services/report-service.js';
import { SlotService } from './services/slot-service.js';

/** The composition root: the one place adapters are constructed and wired to ports. */
export function createApp(opts: { clock?: Clock } = {}) {
  const clock = opts.clock ?? { now: () => Date.now() };
  const events = new EventLog();
  const audit = new AuditLog();
  const bookingRepo = new MemoryBookingRepository();
  const customerRepo = new MemoryCustomerRepository();
  const slotRepo = new MemorySlotRepository();
  const discountRepo = new MemoryDiscountRepository();
  const customers = new CustomerService(customerRepo, audit, clock);
  const slots = new SlotService(slotRepo);
  const bookings = new BookingService(bookingRepo, customerRepo, slotRepo, events, clock, discountRepo);
  const notifications = new NotificationService(events);
  const reports = new ReportService(events);
  const http = createHttp({ bookings, customers, slots, reports });
  return { clock, events, audit, bookingRepo, customerRepo, slotRepo, discounts: discountRepo, customers, slots, bookings, notifications, reports, http };
}
