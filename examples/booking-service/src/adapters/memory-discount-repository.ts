import type { DiscountCode, DiscountRepository } from '../ports/discount-repository.js';

export class MemoryDiscountRepository implements DiscountRepository {
  private readonly discounts = new Map<string, DiscountCode>();

  get(code: string): DiscountCode | undefined {
    return this.discounts.get(code);
  }

  save(discount: DiscountCode): void {
    this.discounts.set(discount.code, discount);
  }
}
