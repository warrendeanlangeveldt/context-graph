import { customer, suspend, type Customer, type CustomerKind } from '../domain/customer.js';
import { DomainError } from '../domain/errors.js';
import type { AuditLog } from '../domain/audit.js';
import type { CustomerRepository } from '../ports/customer-repository.js';
import type { Clock } from './clock.js';

export class CustomerService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

  register(input: { id: string; name: string; kind?: CustomerKind }, actor: string): Customer {
    if (this.customers.get(input.id)) throw new DomainError('VALIDATION', `customer ${input.id} already exists`);
    const c = customer(input.id, input.name, input.kind ?? 'regular');
    this.customers.save(c);
    this.audit.record({ actor, action: 'customer.register', target: c.id, at: this.clock.now() });
    return c;
  }

  suspend(id: string, actor: string): Customer {
    const c = this.get(id);
    const next = suspend(c);
    this.customers.save(next);
    this.audit.record({ actor, action: 'customer.suspend', target: id, at: this.clock.now() });
    return next;
  }

  get(id: string): Customer {
    const c = this.customers.get(id);
    if (!c) throw new DomainError('NOT_FOUND', `no customer ${id}`);
    return c;
  }
}
