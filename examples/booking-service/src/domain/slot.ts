import type { Cents } from './money.js';

export interface Slot {
  readonly id: string;
  /** Epoch milliseconds. */
  readonly startsAt: number;
  readonly basePrice: Cents;
  readonly minimumPrice: Cents;
  readonly peak: boolean;
}
