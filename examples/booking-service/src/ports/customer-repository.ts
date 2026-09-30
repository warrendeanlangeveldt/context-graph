import type { Customer } from '../domain/customer.js';

export interface CustomerRepository {
  get(id: string): Customer | undefined;
  save(customer: Customer): void;
}
