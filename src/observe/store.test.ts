import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionState, mergeState } from './store.js';

describe('session state shared by a session’s hooks', () => {
  let home: string;
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.CTX_HOME;
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.CTX_HOME;
    else process.env.CTX_HOME = before;
  });

  it('keeps what each of two hooks running at once changed', () => {
    const root = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    // Both load the state before either saves, as a PreToolUse hook and the last call's PostToolUse do.
    const pre = new SessionState(root, 's-1');
    const post = new SessionState(root, 's-1');
    pre.data.graphAnnounced = true;
    pre.data.filesAnnounced = ['src/a.ts'];
    pre.save();
    post.data.filesAnnounced = ['src/b.ts'];
    post.data.readsRecorded = ['tu-1'];
    post.save();
    const now = new SessionState(root, 's-1');
    expect(now.data.graphAnnounced).toBe(true);
    expect(now.data.filesAnnounced).toEqual(['src/a.ts', 'src/b.ts']);
    expect(now.data.readsRecorded).toEqual(['tu-1']);
  });

  it('leaves no partial or temporary files behind', () => {
    const root = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    const s = new SessionState(root, 's-2');
    s.data.graphAnnounced = true;
    s.save();
    const dir = join(s.file, '..');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('merges three ways: unchanged keeps the disk, lists and maps add and remove, scalars take the change', () => {
    const base = { blocks: 1, arm: 'on', list: ['a', 'b'], map: { x: 1, y: 2 }, flag: false };
    const mine = { blocks: 2, arm: 'on', list: ['b', 'c'], map: { x: 1, z: 3 }, flag: false };
    const theirs = { blocks: 1, arm: 'off', list: ['a', 'b', 'd'], map: { x: 9, y: 2, w: 4 }, flag: true };
    expect(mergeState(base, mine, theirs)).toEqual({
      blocks: 2,
      arm: 'off',
      list: ['b', 'd', 'c'],
      map: { x: 9, w: 4, z: 3 },
      flag: true,
    });
  });
});
