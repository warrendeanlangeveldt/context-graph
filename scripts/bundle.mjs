#!/usr/bin/env node
// Bundles the CLI into one ES module and places a copy inside each adapter directory, so a plugin
// works from a bare clone or a marketplace install with no build step. `--check` rebuilds to a
// temporary file and fails when a committed copy differs, for CI.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['adapters/claude-code/ctx.mjs', 'adapters/codex/ctx.mjs'].map((t) => join(root, t));
const check = process.argv.includes('--check');

// Harnesses only fetch a plugin whose manifest version changed, so the package version is the
// single source: bump it in package.json and every manifest follows on the next bundle.
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const manifests = ['adapters/claude-code/.claude-plugin/plugin.json', 'adapters/codex/.codex-plugin/plugin.json', '.claude-plugin/marketplace.json'].map((m) => join(root, m));
for (const m of manifests) {
  const text = readFileSync(m, 'utf8');
  const stamped = text.replace(/"version":\s*"[^"]*"/g, `"version": "${version}"`);
  if (check) { if (stamped !== text) { console.error(`${m} carries a version other than ${version}; run npm run bundle`); process.exit(1); } }
  else if (stamped !== text) writeFileSync(m, stamped, 'utf8');
}
const outfile = check ? join(mkdtempSync(join(tmpdir(), 'ctx-bundle-')), 'ctx.mjs') : targets[0];

await build({
  entryPoints: [join(root, 'src/cli/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  // esbuild hoists the entry file's own hashbang; the banner only supplies `require` for bundled CommonJS dependencies.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  // Native or optional modules stay external: the ONNX runtime is resolved from the package's node_modules when embeddings are enabled.
  external: ['@huggingface/transformers', 'onnxruntime-node', 'bufferutil', 'utf-8-validate', 'sharp'],
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.CTX_BUNDLED': '"1"', __CTX_VERSION__: JSON.stringify(version) },
});

if (check) {
  const fresh = readFileSync(outfile, 'utf8');
  for (const t of targets) {
    if (!existsSync(t) || readFileSync(t, 'utf8') !== fresh) { console.error(`${t} is stale; run npm run bundle`); process.exit(1); }
  }
  console.log('bundles are current');
} else {
  for (const t of targets.slice(1)) copyFileSync(targets[0], t);
  const kb = Math.round(readFileSync(targets[0]).length / 1024);
  console.log(`bundled ${targets.length} copies of ctx.mjs (${kb} KB), manifests at version ${version}`);
}
