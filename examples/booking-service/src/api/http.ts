import { DomainError, type ErrorCode } from '../domain/errors.js';
import type { BookingService } from '../services/booking-service.js';
import type { CustomerService } from '../services/customer-service.js';
import type { ReportService } from '../services/report-service.js';
import type { SlotService } from '../services/slot-service.js';

export interface HttpRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

/**
 * Every error leaves this layer in one shape, `{ error: { code, message } }`, with the DomainError code
 * verbatim and the status from STATUS. Clients switch on `code`; they never parse `message`.
 */
const STATUS: Record<ErrorCode, number> = { NOT_FOUND: 404, INVALID_TRANSITION: 409, SLOT_TAKEN: 409, VALIDATION: 400, LIMIT: 429 };

export function errorResponse(e: unknown): HttpResponse {
  if (e instanceof DomainError) return { status: STATUS[e.code], body: { error: { code: e.code, message: e.message } } };
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected error' } } };
}

type Handler = (params: Record<string, string>, body: Record<string, unknown>) => HttpResponse;

export interface Services {
  bookings: BookingService;
  customers: CustomerService;
  slots: SlotService;
  reports: ReportService;
}

export function createHttp(s: Services): (req: HttpRequest) => HttpResponse {
  const routes: { method: HttpRequest['method']; pattern: RegExp; handler: Handler }[] = [
    {
      method: 'POST',
      pattern: /^\/customers$/,
      handler: (_p, body) => ({ status: 201, body: { customer: s.customers.register({ id: String(body.id), name: String(body.name) }, String(body.actor ?? 'anonymous')) } }),
    },
    {
      method: 'POST',
      pattern: /^\/slots$/,
      handler: (_p, body) => ({ status: 201, body: { slot: s.slots.create({ id: String(body.id), startsAt: Number(body.startsAt), basePrice: Number(body.basePrice), minimumPrice: Number(body.minimumPrice), peak: body.peak === true }) } }),
    },
    {
      method: 'POST',
      pattern: /^\/bookings$/,
      handler: (_p, body) => ({ status: 201, body: { booking: s.bookings.request({ id: String(body.id), slotId: String(body.slotId), customerId: String(body.customerId) }) } }),
    },
    {
      method: 'POST',
      pattern: /^\/bookings\/(?<id>[^/]+)\/confirm$/,
      handler: (p) => ({ status: 200, body: { booking: s.bookings.confirm(p.id!) } }),
    },
    {
      method: 'POST',
      pattern: /^\/bookings\/(?<id>[^/]+)\/cancel$/,
      handler: (p) => {
        const result = s.bookings.cancel(p.id!);
        return { status: 202, body: { booking: result.booking, fee: result.fee, refund: result.refund, promoted: result.promoted } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/bookings\/(?<id>[^/]+)$/,
      handler: (p) => ({ status: 200, body: { booking: s.bookings.get(p.id!) } }),
    },
    {
      method: 'GET',
      pattern: /^\/reports\/revenue$/,
      handler: () => ({ status: 200, body: { revenue: s.reports.revenue() } }),
    },
  ];

  return (req) => {
    for (const r of routes) {
      const m = r.method === req.method ? r.pattern.exec(req.path) : null;
      if (!m) continue;
      try {
        return r.handler(m.groups ?? {}, req.body ?? {});
      } catch (e) {
        return errorResponse(e);
      }
    }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: `no route ${req.method} ${req.path}` } } };
  };
}
