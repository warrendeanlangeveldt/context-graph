import { DomainError } from '../domain/errors.js';
import { cents } from '../domain/money.js';
import type { Slot } from '../domain/slot.js';
import type { SlotRepository } from '../ports/slot-repository.js';

export class SlotService {
  constructor(private readonly slots: SlotRepository) {}

  create(input: { id: string; startsAt: number; basePrice: number; minimumPrice: number; peak?: boolean }): Slot {
    if (this.slots.get(input.id)) throw new DomainError('VALIDATION', `slot ${input.id} already exists`);
    const slot: Slot = { id: input.id, startsAt: input.startsAt, basePrice: cents(input.basePrice), minimumPrice: cents(input.minimumPrice), peak: input.peak ?? false };
    this.slots.save(slot);
    return slot;
  }

  get(id: string): Slot {
    const s = this.slots.get(id);
    if (!s) throw new DomainError('NOT_FOUND', `no slot ${id}`);
    return s;
  }
}
