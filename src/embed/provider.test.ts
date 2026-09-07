import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../core/context.js';
import { EMBEDDED_PACKS } from '../generated/packs.js';
import { loadPacks, packFromText } from '../init/packs.js';
import { ctxHome } from '../util/paths.js';
import { cosine, makeProvider } from './provider.js';

describe('makeProvider', () => {
  const cfg = (provider: string, baseUrl?: string) => ({ ...defaultConfig().embed, provider, ...(baseUrl ? { baseUrl } : {}) });

  it('accepts every provider spelling and rejects unknown ones', () => {
    expect(makeProvider(cfg('minilm')).id).toBe('minilm');
    expect(makeProvider(cfg('onnx:Xenova/bge-small-en-v1.5')).id).toBe('onnx:Xenova/bge-small-en-v1.5');
    expect(makeProvider(cfg('local:nomic-embed-text')).id).toBe('local:nomic-embed-text');
    expect(makeProvider(cfg('openai:text-embedding-3-small')).id).toBe('openai:text-embedding-3-small');
    expect(makeProvider(cfg('https://api.voyageai.com/v1#voyage-code-3')).id).toBe('https://api.voyageai.com/v1#voyage-code-3');
    expect(() => makeProvider(cfg('magic'))).toThrow(/unrecognised embedding provider/);
  });

  // Runs the real in-process model when its files are already cached under ~/.ctx/models, so a
  // unit test never downloads anything. `ctx embed build` on any repository fills the cache.
  const cached = existsSync(join(ctxHome(), 'models', 'Xenova', 'all-MiniLM-L6-v2'));
  it.skipIf(!cached)('embeds in-process with MiniLM and ranks related text closer', async () => {
    const p = makeProvider(cfg('minilm'));
    const [a, b, c] = await p.embed(['retry the queue consumer with backoff', 'bounded retries for message handlers', 'the colour palette of the login page']);
    expect(a!.length).toBe(384);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  }, 120_000);
});

describe('embedded packs', () => {
  it('carry every pack file and parse identically', () => {
    const fromDisk = loadPacks(['auto']);
    expect(Object.keys(EMBEDDED_PACKS).sort()).toEqual(fromDisk.map((p) => p.name).sort());
    for (const p of fromDisk) {
      const embedded = packFromText(p.name, EMBEDDED_PACKS[p.name]!, 'embedded');
      expect(embedded.records.length).toBe(p.records.length);
      expect(embedded.roles.map((r) => r.role)).toEqual(p.roles.map((r) => r.role));
    }
  });
});
