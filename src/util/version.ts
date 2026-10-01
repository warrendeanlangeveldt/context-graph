import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from './root.js';

// Stamped into the single-file bundle at build time (scripts/bundle.mjs), which may run without its package.json.
declare const __CTX_VERSION__: string | undefined;

/** The running ctx's version: the bundle's stamp, else the package's own package.json. */
export function ctxVersion(): string {
  if (typeof __CTX_VERSION__ === 'string') return __CTX_VERSION__;
  try {
    return (JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
