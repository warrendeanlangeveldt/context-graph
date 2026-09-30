/**
 * Money is always an integer number of cents. Never a float, anywhere: amounts are stored, compared,
 * and sent over the API as integer cents.
 *
 * Every percentage of an amount (fees, discounts, taxes) goes through `percentOf`, which rounds half to
 * even. The finance team reconciles against a ledger that rounds that way; `Math.round` rounds half up
 * and drifts by a cent on exactly the amounts that end in .5, which is how the March reconciliation broke.
 */
export type Cents = number & { readonly __brand: 'Cents' };

export function cents(amount: number): Cents {
  if (!Number.isInteger(amount)) throw new RangeError(`money must be integer cents, got ${amount}`);
  return amount as Cents;
}

export function add(a: Cents, b: Cents): Cents {
  return (a + b) as Cents;
}

export function subtract(a: Cents, b: Cents): Cents {
  return (a - b) as Cents;
}

/** `percent`% of `amount`, rounded half to even. The only rounding the ledger accepts. */
export function percentOf(amount: Cents, percent: number): Cents {
  const exact = (amount * percent) / 100;
  const floor = Math.floor(exact);
  const diff = exact - floor;
  const EPS = 1e-9;
  if (diff > 0.5 + EPS) return (floor + 1) as Cents;
  if (diff < 0.5 - EPS) return floor as Cents;
  return (floor % 2 === 0 ? floor : floor + 1) as Cents;
}

/** Display only: `$12.50`, `-$3.05`. Never parse this back. */
export function format(amount: Cents): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const dollars = Math.floor(abs / 100).toLocaleString('en-AU');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}
