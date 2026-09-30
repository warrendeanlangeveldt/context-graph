export interface DiscountCode {
  code: string;
  percent: number;
}

export interface DiscountRepository {
  get(code: string): DiscountCode | undefined;
  save(discount: DiscountCode): void;
}
