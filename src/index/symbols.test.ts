import { describe, expect, it } from 'vitest';
import { enclosingSymbol, lineRangeOf, topLevelSymbols } from './symbols.js';

const SRC = `import { x } from './x.js';

export const LIMIT = 3;

/** A class with a brace in a string "{" */
export class Blackboard {
  applyEvent(e: Event): void {
    if (e.kind === 'a') {
      this.state = 'x'; // }
    }
  }
}

export function helper(a: number): number {
  return a + 1;
}

const local = () => {
  return 1;
};
`;

describe('symbols', () => {
  it('finds top-level spans', () => {
    const spans = topLevelSymbols(SRC).map((s) => [s.name, s.start, s.end]);
    expect(spans).toEqual([
      ['LIMIT', 3, 3],
      ['Blackboard', 6, 12],
      ['helper', 14, 16],
      ['local', 18, 20],
    ]);
  });

  it('resolves the enclosing symbol for a line', () => {
    expect(enclosingSymbol(SRC, 9)).toBe('Blackboard');
    expect(enclosingSymbol(SRC, 15)).toBe('helper');
    expect(enclosingSymbol(SRC, 1)).toBeUndefined();
  });

  it('locates a substring by line range', () => {
    expect(lineRangeOf(SRC, "this.state = 'x'")).toEqual([9, 9]);
    expect(lineRangeOf(SRC, 'export function helper(a: number): number {\n  return a + 1;')).toEqual([14, 15]);
    expect(lineRangeOf(SRC, 'nope')).toBeUndefined();
  });
});
