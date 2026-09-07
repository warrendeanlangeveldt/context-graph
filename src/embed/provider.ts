import type { EmbedConfig } from '../core/context.js';

/** Design spec §10.3. Nothing here names a vendor beyond the wire shapes two ecosystems share. */
export interface EmbeddingProvider {
  id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
const OPENAI_DEFAULT = 'https://api.openai.com/v1';

/**
 * Provider string forms:
 *   local:<model>          Ollama's native embed endpoint at base_url (default 127.0.0.1:11434)
 *   openai:<model>         OpenAI-compatible /embeddings at base_url (default api.openai.com/v1), key from api_key_env
 *   <base-url>#<model>     any OpenAI-compatible endpoint
 */
export function makeProvider(cfg: EmbedConfig): EmbeddingProvider {
  const spec = cfg.provider;
  if (spec.startsWith('local:')) return ollama(cfg.baseUrl ?? OLLAMA_DEFAULT, spec.slice(6), spec);
  if (spec.startsWith('openai:')) return openaiCompatible(cfg.baseUrl ?? OPENAI_DEFAULT, spec.slice(7), process.env[cfg.apiKeyEnv], spec);
  const hash = spec.lastIndexOf('#');
  if (hash > 0) return openaiCompatible(spec.slice(0, hash), spec.slice(hash + 1), process.env[cfg.apiKeyEnv], spec);
  throw new Error(`unrecognised embedding provider "${spec}": use local:<model>, openai:<model>, or <base-url>#<model>`);
}

function ollama(baseUrl: string, model: string, id: string): EmbeddingProvider {
  return {
    id,
    async embed(texts) {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
      const j = (await res.json()) as { embeddings: number[][] };
      return j.embeddings.map((e) => Float32Array.from(e));
    },
  };
}

function openaiCompatible(baseUrl: string, model: string, apiKey: string | undefined, id: string): EmbeddingProvider {
  return {
    id,
    async embed(texts) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
      const j = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return j.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
    },
  };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i]!, y = b[i]!; dot += x * y; na += x * x; nb += y * y; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
