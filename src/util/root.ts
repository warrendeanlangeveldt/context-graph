import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the plugin's own files live: packs, adapter directories, the built view. Works from the
 * compiled `dist/` tree, from the single-file bundle inside an adapter directory, and from an
 * npm install, by walking up to the package.json that carries the `contextGraph` marker. When
 * nothing above the script is the package (a marketplace install that copied only the plugin
 * directory), the script's own directory is the root and callers fall back to embedded resources.
 */
let cached: string | undefined;

export function packageRoot(from = fileURLToPath(import.meta.url)): string {
  if (cached) return cached;
  let dir = dirname(from);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, 'utf8')) as { contextGraph?: boolean };
        if (j.contextGraph) { cached = dir; return dir; }
      } catch { /* not ours */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = resolve(dirname(from));
  return cached;
}

/** True when the package's resource directories are present (a clone or npm install), false for a plugin-only copy. */
export function hasPackageResources(): boolean {
  return existsSync(join(packageRoot(), 'packs')) && existsSync(join(packageRoot(), 'adapters'));
}
