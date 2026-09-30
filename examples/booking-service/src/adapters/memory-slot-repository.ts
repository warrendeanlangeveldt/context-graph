import type { Slot } from '../domain/slot.js';
import type { SlotRepository } from '../ports/slot-repository.js';

export class MemorySlotRepository implements SlotRepository {
  private readonly slots = new Map<string, Slot>();

  get(id: string): Slot | undefined {
    return this.slots.get(id);
  }

  save(slot: Slot): void {
    this.slots.set(slot.id, slot);
  }
}
