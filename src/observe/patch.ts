/**
 * Patch observers. `apply_patch` is the edit format Codex uses; unified diffs arrive through
 * `git apply`, `patch`, and heredocs. Both recover the paths a patch touches; unified diffs
 * also recover line ranges on the new side.
 */

export interface PatchFile {
  path: string;
  kind: 'add' | 'update' | 'delete';
  movedTo?: string;
  ranges?: [number, number][];
}

export function parseApplyPatch(text: string): PatchFile[] {
  const out: PatchFile[] = [];
  let cur: PatchFile | undefined;
  for (const line of text.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) { cur = { path: m[1]!.trim(), kind: 'add' }; out.push(cur); continue; }
    if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) { cur = { path: m[1]!.trim(), kind: 'update' }; out.push(cur); continue; }
    if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) { cur = { path: m[1]!.trim(), kind: 'delete' }; out.push(cur); continue; }
    if ((m = /^\*\*\* Move to: (.+)$/.exec(line)) && cur) { cur.movedTo = m[1]!.trim(); continue; }
  }
  return out;
}

export function parseUnifiedDiff(text: string): PatchFile[] {
  const out: PatchFile[] = [];
  let cur: PatchFile | undefined;
  let oldPath: string | undefined;
  const strip = (p: string): string => p.replace(/^[ab]\//, '').trim();
  for (const line of text.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line))) { oldPath = m[1]!; continue; }
    if ((m = /^--- (.+)$/.exec(line))) { oldPath = m[1]!.trim() === '/dev/null' ? undefined : strip(m[1]!); continue; }
    if ((m = /^\+\+\+ (.+)$/.exec(line))) {
      const newPath = m[1]!.trim() === '/dev/null' ? undefined : strip(m[1]!);
      if (newPath) {
        cur = { path: newPath, kind: oldPath ? 'update' : 'add', ranges: [] };
        if (oldPath && oldPath !== newPath) { cur.path = oldPath; cur.movedTo = newPath; }
      } else if (oldPath) {
        cur = { path: oldPath, kind: 'delete' };
      } else cur = undefined;
      if (cur) out.push(cur);
      continue;
    }
    if ((m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)) && cur?.ranges) {
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      cur.ranges.push([start, start + Math.max(len, 1) - 1]);
    }
  }
  return out;
}

/** Detect the patch format in free text; null when the text is not a patch. */
export function parsePatchText(text: string): PatchFile[] | null {
  if (text.includes('*** Begin Patch') || /^\*\*\* (Add|Update|Delete) File:/m.test(text)) return parseApplyPatch(text);
  if (/^\+\+\+ /m.test(text) && /^@@ /m.test(text)) return parseUnifiedDiff(text);
  return null;
}
