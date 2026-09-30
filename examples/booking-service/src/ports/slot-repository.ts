import type { Slot } from '../domain/slot.js';

export interface SlotRepository {
  get(id: string): Slot | undefined;
  save(slot: Slot): void;
}
