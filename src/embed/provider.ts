import { join } from 'node:path';
import type { EmbedConfig } from '../core/context.js';
import { ctxHome } from '../util/paths.js';

/** Design spec §10.3. Nothing here names a vendor beyond the wire shapes two ecosystems share. */
export interface EmbeddingProvider {
  id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
const OPENAI_DEFAULT = 'https://api.openai.com/v1';
const MINILM = 'Xenova/all-MiniLM-L6-v2';

/**
 * Provider string forms:
 *   minilm                 in-process MiniLM through ONNX; no service, no key; the model (about 23 MB) is fetched once into ~/.ctx/models
 *   onnx:<hf-model-id>     any sentence-embedding model transformers.js can run in-process
 *   local:<model>          Ollama's native embed endpoint at base_url (default 127.0.0.1:11434)
 *   openai:<model>         OpenAI-compatible /embeddings at base_url (default api.openai.com/v1), key from api_key_env
 *   <base-url>#<model>     any OpenAI-compatible endpoint
 */
export function makeProvider(cfg: EmbedConfig): EmbeddingProvider {
  const spec = cfg.provider;
  if (spec === 'minilm') return onnx(MINILM, spec);
  if (spec.startsWith('onnx:')) return onnx(spec.slice(5), spec);
  if (spec.startsWith('local:')) return ollama(cfg.baseUrl ?? OLLAMA_DEFAULT, spec.slice(6), spec);
  if (spec.startsWith('openai:')) return openaiCompatible(cfg.baseUrl ?? OPENAI_DEFAULT, spec.slice(7), process.env[cfg.apiKeyEnv], spec);
  const hash = spec.lastIndexOf('#');
  if (hash > 0) return openaiCompatible(spec.slice(0, hash), spec.slice(hash + 1), process.env[cfg.apiKeyEnv], spec);
  throw new Error(`unrecognised embedding provider "${spec}": use minilm, onnx:<model>, local:<model>, openai:<model>, or <base-url>#<model>`);
}

/** In-process embeddings through transformers.js and the ONNX runtime. Loaded on demand so hooks never pay for it. */
function onnx(model: string, id: string): EmbeddingProvider {
  let extractor: Promise<(texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>> | undefined;
  const load = async (): Promise<Awaited<NonNullable<typeof extractor>>> => {
    if (!extractor) {
      extractor = (async () => {
        let mod: { pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown>; env: { cacheDir: string; allowLocalModels: boolean } };
        try {
          mod = (await import('@huggingface/transformers')) as unknown as typeof mod;
        } catch {
          throw new Error('in-process embeddings need the @huggingface/transformers package; install it next to ctx (npm i -g @huggingface/transformers, about 350MB), or choose local:<model> or openai:<model> in [embed] provider');
        }
        mod.env.cacheDir = join(ctxHome(), 'models');
        mod.env.allowLocalModels = true;
        const pipe = await mod.pipeline('feature-extraction', model, { dtype: 'q8' });
        return pipe as Awaited<NonNullable<typeof extractor>>;
      })();
    }
    return extractor;
  };
  return {
    id,
    async embed(texts) {
      const pipe = await load();
      const out: Float32Array[] = [];
      // Small batches keep memory flat on long indexing runs.
      for (let i = 0; i < texts.length; i += 8) {
        const tensor = await pipe(texts.slice(i, i + 8), { pooling: 'mean', normalize: true });
        for (const row of tensor.tolist()) out.push(Float32Array.from(row));
      }
      return out;
    },
  };
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
      const j = (await res.json()) as { embeddings?: number[][]; error?: string };
      if (!j.embeddings) throw new Error(`the model "${model}" returned no embeddings${j.error ? `: ${j.error}` : ''}; it may be a chat model. Pull an embedding model such as nomic-embed-text, or use provider = "minilm"`);
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
