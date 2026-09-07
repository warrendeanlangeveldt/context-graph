import { describe, expect, it } from 'vitest';
import { chunkFile } from './chunker.js';
import { cosine } from './provider.js';
import { SqliteVectorStore } from './store.js';

describe('chunker', () => {
  it('splits code at symbol boundaries and prose at headings', () => {
    const code = chunkFile('src/a.ts', 'import x from "y";\n\nexport function one() {\n  return 1;\n}\n\nexport class Two {\n  m() {}\n}\n');
    expect(code.map((c) => c.ref)).toEqual(['src/a.ts#one', 'src/a.ts#Two']);
    expect(code[0]).toMatchObject({ kind: 'code', start: 3, end: 5 });
    const doc = chunkFile('docs/x.md', '# Title\n\nintro\n\n## Second\n\nbody\n');
    expect(doc.map((c) => c.ref)).toEqual(['docs/x.md:1 Title', 'docs/x.md:5 Second']);
    expect(chunkFile('a.yaml', 'k: v\n')[0]).toMatchObject({ kind: 'doc', ref: 'a.yaml:1' });
  });

  it('splits an overlong symbol into pieces that keep the ref', () => {
    const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const chunks = chunkFile('src/big.ts', `export function big() {\n${body}\n}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks.map((c) => c.ref))).toEqual(new Set(['src/big.ts#big']));
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });
});

describe('SqliteVectorStore', () => {
  it('round-trips vectors and ranks by cosine', () => {
    const s = new SqliteVectorStore(':memory:');
    const v = (a: number, b: number): Float32Array => Float32Array.from([a, b]);
    s.upsert([
      { chunk: { id: 'x', kind: 'code', ref: 'x', path: 'x.ts', start: 1, end: 2, text: 'x text', hash: 'h1' }, vector: v(1, 0), provider: 'p' },
      { chunk: { id: 'y', kind: 'doc', ref: 'y', path: 'y.md', start: 1, end: 2, text: 'y text', hash: 'h2' }, vector: v(0, 1), provider: 'p' },
      { chunk: { id: 'z', kind: 'decision', ref: 'd-1', path: null, start: null, end: null, text: 'old', hash: 'h3', archived: true }, vector: v(1, 0.1), provider: 'p' },
    ]);
    expect(s.count()).toBe(3);
    expect(s.providerId()).toBe('p');
    const hits = s.query(v(1, 0.2), 5);
    expect(hits.map((h) => h.id)).toEqual(['x', 'y']);
    expect(hits[0]!.score).toBeCloseTo(cosine(v(1, 0.2), v(1, 0)), 5);
    expect(s.query(v(1, 0.2), 5, { includeArchived: true }).map((h) => h.id)).toEqual(['z', 'x', 'y']);
    expect(s.hashes().get('y')).toBe('h2');
    s.upsert([{ chunk: { id: 'y', kind: 'doc', ref: 'y', path: 'y.md', start: 1, end: 2, text: 'y2', hash: 'h9' }, vector: v(1, 0), provider: 'p' }]);
    expect(s.hashes().get('y')).toBe('h9');
    s.remove(['x']);
    expect(s.count()).toBe(2);
    expect(s.removeByPath('y.md')).toBe(1);
    s.close();
  });
});
