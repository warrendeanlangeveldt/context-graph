import { describe, expect, it } from 'vitest';
import { add, cents, format, percentOf, subtract } from '../src/domain/money.js';

describe('money', () => {
  it('MONEY-1 is integer cents only', () => {
    expect(() => cents(10.5)).toThrow(RangeError);
    expect(add(cents(150), cents(250))).toBe(400);
    expect(subtract(cents(500), cents(125))).toBe(375);
  });

  it('MONEY-2 takes percentages rounding half to even', () => {
    expect(percentOf(cents(1000), 10)).toBe(100);
    expect(percentOf(cents(1005), 10)).toBe(100); // 100.5 -> 100
    expect(percentOf(cents(1015), 10)).toBe(102); // 101.5 -> 102
    expect(percentOf(cents(999), 10)).toBe(100); // 99.9 -> 100
  });

  it('MONEY-3 formats for display', () => {
    expect(format(cents(123450))).toBe('$1,234.50');
    expect(format(cents(-305))).toBe('-$3.05');
  });
});
