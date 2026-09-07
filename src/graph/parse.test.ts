import { describe, expect, it } from 'vitest';
import { parseLine, parseText, ParseError } from './parse.js';
import { formatRecord } from './write.js';

describe('parseLine', () => {
  it('parses every record kind', () => {
    expect(parseLine('M api/src/core/** L:core', 1)).toMatchObject({ kind: 'M', glob: 'api/src/core/**', logical: 'L:core' });
    expect(parseLine('L L:core Engine and DSL contracts', 1)).toMatchObject({ kind: 'L', id: 'L:core', name: 'Engine and DSL contracts' });
    expect(parseLine('C C:pure The engine never depends on impls adr:0012', 1)).toMatchObject({ kind: 'C', id: 'C:pure', name: 'The engine never depends on impls', adr: '0012' });
    expect(parseLine('C C:x A proposed one proposed', 1)).toMatchObject({ kind: 'C', proposed: true, name: 'A proposed one' });
    expect(parseLine('E L:core impl C:pure', 1)).toMatchObject({ kind: 'E', from: 'L:core', rel: 'impl', to: 'C:pure' });
    expect(parseLine('E L:a dep L:b proposed', 1)).toMatchObject({ kind: 'E', proposed: true });
    expect(parseLine('K E k.one L:core core never imports impls test:api/boundary.test.ts', 1)).toMatchObject({ kind: 'K', mode: 'E', id: 'k.one', attachedTo: 'L:core', text: 'core never imports impls', test: 'api/boundary.test.ts' });
    expect(parseLine('K G k.two L:core state via events only from:pack@1', 1)).toMatchObject({ kind: 'K', mode: 'G', text: 'state via events only', from: 'pack@1' });
    expect(parseLine('K G? k.three L:core proposed rule', 1)).toMatchObject({ kind: 'K', mode: 'G?' });
    expect(parseLine('S d-0002 d-0001', 1)).toMatchObject({ kind: 'S', newId: 'd-0002', oldId: 'd-0001' });
    expect(parseLine('Z k.one 2026-09-07 warren/human succ:k.four superseded by k.four', 1)).toMatchObject({ kind: 'Z', target: 'k.one', succ: 'k.four', reason: 'superseded by k.four' });
    expect(parseLine('A bb api/src/core/blackboard.ts', 1)).toMatchObject({ kind: 'A', alias: 'bb', node: 'api/src/core/blackboard.ts' });
    expect(parseLine('R {domain} directories named domain or core', 1)).toMatchObject({ kind: 'R', role: '{domain}', heuristic: 'directories named domain or core' });
  });

  it('parses decisions in both arrow spellings', () => {
    const a = parseLine('D d-0001 2026-09-07 warren/claude 4b9947ac main api/x.ts ->K k.one purge guard added', 1);
    expect(a).toMatchObject({ kind: 'D', id: 'd-0001', serves: 'k.one', text: 'purge guard added', node: 'api/x.ts' });
    const b = parseLine('D d-0002 2026-09-07 warren/claude - feature/x L:core ->C pure !K k.two moved to envelope', 1);
    expect(b).toMatchObject({ kind: 'D', serves: 'C:pure', overrides: 'k.two', text: 'moved to envelope', sha: '-' });
    const c = parseLine('D d-0003 2026-09-07 w/c - main api/x.ts ->k.one !k.two compact spelling', 1);
    expect(c).toMatchObject({ kind: 'D', serves: 'k.one', overrides: 'k.two' });
  });

  it('skips blanks and comments', () => {
    expect(parseLine('', 1)).toBeNull();
    expect(parseLine('   # a comment', 1)).toBeNull();
  });

  it('rejects malformed records with file and line', () => {
    expect(() => parseLine('K E k.one L:core no test given', 7, 'graph.ctx')).toThrow(ParseError);
    expect(() => parseLine('K E k.one L:core no test given', 7, 'graph.ctx')).toThrow(/graph.ctx:7/);
    expect(() => parseLine('D d-1 2026-09-07 w/c - main api/x.ts no arrow here', 1)).toThrow(/->/);
    expect(() => parseLine('E L:a near L:b', 1)).toThrow(/relation/);
    expect(() => parseLine('Q something', 1)).toThrow(/unknown record kind/);
    expect(() => parseLine('S d-1 d-1', 1)).toThrow(/itself/);
  });

  it('round-trips through formatRecord', () => {
    const lines = [
      'M api/src/core/** L:core',
      'L L:core Engine',
      'C C:pure Engine never depends on impls adr:0012',
      'E L:core impl C:pure',
      'K E k.one L:core core never imports impls test:api/boundary.test.ts',
      'K G k.two L:core state via events only',
      'D d-0001 2026-09-07 warren/claude 4b9947ac main api/x.ts ->K k.one purge guard added',
      'D d-0002 2026-09-07 warren/claude - feature/x L:core ->C pure !K k.two moved to envelope',
      'S d-0002 d-0001',
      'Z k.one 2026-09-07 warren/human succ:k.two replaced',
      'A bb api/src/core/blackboard.ts',
    ];
    for (const l of lines) expect(formatRecord(parseLine(l, 1)!)).toBe(l);
  });

  it('parseText returns records in order with line numbers', () => {
    const recs = parseText('# c\nM a/** L:a\n\nL L:a A module\n', 'g.ctx');
    expect(recs.map((r) => r.line)).toEqual([2, 4]);
    expect(recs[0]?.file).toBe('g.ctx');
  });
});
