import { add, percentOf, type Cents } from './money.js';
import type { Slot } from './slot.js';

/** Peak slots cost 20% more. */
export function priceFor(slot: Slot): Cents {
  return slot.peak ? add(slot.basePrice, percentOf(slot.basePrice, 20)) : slot.basePrice;
}

export function minimumPrice(slot: Slot): Cents {
  return slot.minimumPrice;
}
