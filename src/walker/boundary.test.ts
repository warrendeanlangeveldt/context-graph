import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Enforces `walker.pure` from .ctx/graph.ctx: the walker and slice renderer are a pure function of
 * graph and path. They may import the graph, token estimation, and Node's path helpers, and
 * nothing that reaches a network, a model, a child process, or the overlay.
 */
const FORBIDDEN_IMPORTS = ['node:child_process', 'node:http', 'node:https', 'node:net', 'ws', '../overlay/', '../embed/', '../adapters/', '../observe/', '../mcp/'];

describe('walker.pure', () => {
  it('src/walker imports nothing impure', () => {
    const dir = join(import.meta.dirname, '.');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      // What a file imports, not what its comments say: a comment that "follows" a rule is not the ws library.
      const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const term of FORBIDDEN_IMPORTS) if (specs.some((s) => s === term || s.startsWith(term))) offenders.push(`${f}: ${term}`);
      if (/(^|[^.\w])fetch\(/m.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))) offenders.push(`${f}: fetch(`);
    }
    expect(offenders).toEqual([]);
  });
});
