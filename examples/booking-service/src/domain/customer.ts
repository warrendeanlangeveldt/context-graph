export type CustomerKind = 'regular' | 'staff';
export type CustomerStatus = 'active' | 'suspended';

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly kind: CustomerKind;
  readonly status: CustomerStatus;
}

export function customer(id: string, name: string, kind: CustomerKind = 'regular'): Customer {
  return { id, name, kind, status: 'active' };
}

export function suspend(c: Customer): Customer {
  return { ...c, status: 'suspended' };
}
