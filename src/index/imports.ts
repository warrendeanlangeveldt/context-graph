import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { headSha } from '../util/git.js';
import { ctxHome, repoHash } from '../util/paths.js';

/**
 * Import graph for JavaScript and TypeScript trees. Relative specifiers are resolved to files;
 * package and path-alias specifiers are left unresolved in this version. The index is derived
 * and disposable: cached per repository, rebuilt when HEAD moves or the cache ages out.
 */
export interface ImportIndex {
  builtAt: string;
  head?: string;
  /** repo-relative file -> repo-relative files it imports */
  imports: Record<string, string[]>;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'build', 'out', 'coverage', '.turbo', '.cache', 'tmp', '.venv', 'venv', '__pycache__', '.idea', '.vscode']);
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const SPEC_RE = /(?:import|export)\s[^'"`]*?\sfrom\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

export function buildImportIndex(root: string): ImportIndex {
  const files: string[] = [];
  walkDir(root, root, files);
  const fileSet = new Set(files);
  const imports: Record<string, string[]> = {};
  for (const f of files) {
    let src: string;
    try { src = readFileSync(join(root, ...f.split('/')), 'utf8'); } catch { continue; }
    const targets = new Set<string>();
    for (const m of src.matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!spec || !spec.startsWith('.')) continue;
      const resolved = resolveSpecifier(f, spec, fileSet);
      if (resolved) targets.add(resolved);
    }
    imports[f] = [...targets];
  }
  const idx: ImportIndex = { builtAt: new Date().toISOString(), imports };
  const head = headSha(root);
  if (head) idx.head = head;
  return idx;
}

function walkDir(root: string, dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkDir(root, full, out);
    else if (EXTS.some((e) => name.endsWith(e)) && !name.endsWith('.d.ts')) out.push(relative(root, full).split(sep).join('/'));
  }
}

function resolveSpecifier(from: string, spec: string, files: Set<string>): string | undefined {
  const base = resolve('/', dirname(from), spec).slice(1);
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  const candidates = [
    base,
    ...EXTS.map((e) => stripped + e),
    ...EXTS.map((e) => `${stripped}/index${e}`),
  ];
  return candidates.find((c) => files.has(c));
}

export function callersOf(index: ImportIndex, path: string): string[] {
  const out: string[] = [];
  for (const [file, targets] of Object.entries(index.imports)) if (targets.includes(path)) out.push(file);
  return out.sort();
}

export function loadOrBuildImportIndex(root: string, maxAgeMs = 15 * 60 * 1000): ImportIndex {
  const dir = join(ctxHome(), 'index');
  const file = join(dir, `${repoHash(root)}.json`);
  const head = headSha(root);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as ImportIndex;
      const age = Date.now() - new Date(cached.builtAt).getTime();
      if (cached.head === head && age < maxAgeMs) return cached;
    } catch { /* rebuild */ }
  }
  const idx = buildImportIndex(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(idx), 'utf8');
  return idx;
}
