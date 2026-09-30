import type { Customer } from '../domain/customer.js';
import type { CustomerRepository } from '../ports/customer-repository.js';

export class MemoryCustomerRepository implements CustomerRepository {
  private readonly customers = new Map<string, Customer>();

  get(id: string): Customer | undefined {
    return this.customers.get(id.toLowerCase());
  }

  save(customer: Customer): void {
    this.customers.set(customer.id.toLowerCase(), customer);
  }
}
