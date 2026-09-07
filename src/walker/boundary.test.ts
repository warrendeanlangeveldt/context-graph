import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Enforces `walker.pure` from .ctx/graph.ctx: the walker and slice renderer are a pure function of
 * graph and path. They may import the graph, token estimation, and Node's path helpers, and
 * nothing that reaches a network, a model, a child process, or the overlay.
 */
const FORBIDDEN = ['node:child_process', 'node:http', 'node:https', 'node:net', 'ws', '../overlay/', '../embed/', '../adapters/', '../observe/', '../mcp/', 'fetch('];

describe('walker.pure', () => {
  it('src/walker imports nothing impure', () => {
    const dir = join(import.meta.dirname, '.');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const term of FORBIDDEN) if (src.includes(term)) offenders.push(`${f}: ${term}`);
    }
    expect(offenders).toEqual([]);
  });
});
