import { describe, expect, it } from 'vitest';
import { parseApplyPatch, parsePatchText, parseUnifiedDiff } from './patch.js';

describe('patch parsers', () => {
  it('reads apply_patch headers', () => {
    const p = `*** Begin Patch
*** Update File: api/src/a.ts
@@ def
-old
+new
*** Add File: api/src/b.ts
+content
*** Delete File: api/src/c.ts
*** Update File: api/src/d.ts
*** Move to: api/src/e.ts
@@
-x
+y
*** End Patch`;
    expect(parseApplyPatch(p)).toEqual([
      { path: 'api/src/a.ts', kind: 'update' },
      { path: 'api/src/b.ts', kind: 'add' },
      { path: 'api/src/c.ts', kind: 'delete' },
      { path: 'api/src/d.ts', kind: 'update', movedTo: 'api/src/e.ts' },
    ]);
  });

  it('reads unified diffs with new-side ranges', () => {
    const d = `diff --git a/api/src/a.ts b/api/src/a.ts
--- a/api/src/a.ts
+++ b/api/src/a.ts
@@ -10,3 +10,4 @@
 a
-b
+c
+d
@@ -40 +41,2 @@
+e
--- /dev/null
+++ b/api/src/new.ts
@@ -0,0 +1,2 @@
+x
+y
--- a/api/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-x
`;
    expect(parseUnifiedDiff(d)).toEqual([
      { path: 'api/src/a.ts', kind: 'update', ranges: [[10, 13], [41, 42]] },
      { path: 'api/src/new.ts', kind: 'add', ranges: [[1, 2]] },
      { path: 'api/src/gone.ts', kind: 'delete' },
    ]);
  });

  it('detects the format', () => {
    expect(parsePatchText('*** Update File: x.ts\n')).toEqual([{ path: 'x.ts', kind: 'update' }]);
    expect(parsePatchText('--- a/x\n+++ b/x\n@@ -1 +1 @@\n')).toEqual([{ path: 'x', kind: 'update', ranges: [[1, 1]] }]);
    expect(parsePatchText('just text')).toBeNull();
  });
});
