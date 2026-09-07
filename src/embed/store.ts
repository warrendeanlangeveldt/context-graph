import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cosine } from './provider.js';

/**
 * SQLite-backed vector store (design spec §10.3, local mode). Vectors are stored as float32
 * blobs and searched by exact cosine over the whole table, which is the right trade for tens of
 * thousands of chunks and needs no native extension. The store is derived and disposable.
 */
export interface StoredChunk {
  id: string;
  kind: string;
  ref: string;
  path: string | null;
  start: number | null;
  end: number | null;
  text: string;
  hash: string;
  provider: string;
  archived: number;
}

export interface Hit extends StoredChunk { score: number }

export class SqliteVectorStore {
  private db: DatabaseSync;
  private cache: { id: string; vector: Float32Array; row: StoredChunk }[] | null = null;

  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, path TEXT, start INTEGER, end INTEGER,
      text TEXT NOT NULL, hash TEXT NOT NULL, provider TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL)`);
    this.db.exec('CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path)');
  }

  upsert(items: { chunk: Omit<StoredChunk, 'provider' | 'archived'> & { archived?: boolean }; vector: Float32Array; provider: string }[]): void {
    const stmt = this.db.prepare(`INSERT INTO chunks (id, kind, ref, path, start, end, text, hash, provider, dims, vector, archived, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, ref=excluded.ref, path=excluded.path, start=excluded.start, end=excluded.end,
        text=excluded.text, hash=excluded.hash, provider=excluded.provider, dims=excluded.dims, vector=excluded.vector, archived=excluded.archived, updated=excluded.updated`);
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      for (const it of items) {
        const c = it.chunk;
        stmt.run(c.id, c.kind, c.ref, c.path, c.start, c.end, c.text, c.hash, it.provider, it.vector.length, Buffer.from(it.vector.buffer, it.vector.byteOffset, it.vector.byteLength), c.archived ? 1 : 0, now);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.cache = null;
  }

  remove(ids: string[]): void {
    if (!ids.length) return;
    const stmt = this.db.prepare('DELETE FROM chunks WHERE id = ?');
    for (const id of ids) stmt.run(id);
    this.cache = null;
  }

  removeByPath(path: string): number {
    const r = this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path);
    this.cache = null;
    return Number(r.changes);
  }

  hashes(): Map<string, string> {
    const out = new Map<string, string>();
    for (const row of this.db.prepare('SELECT id, hash FROM chunks').all() as { id: string; hash: string }[]) out.set(row.id, row.hash);
    return out;
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n);
  }

  providerId(): string | undefined {
    const row = this.db.prepare('SELECT provider FROM chunks LIMIT 1').get() as { provider: string } | undefined;
    return row?.provider;
  }

  query(vector: Float32Array, k: number, opts: { includeArchived?: boolean } = {}): Hit[] {
    if (!this.cache) {
      this.cache = (this.db.prepare('SELECT id, kind, ref, path, start, end, text, hash, provider, dims, vector, archived FROM chunks').all() as unknown as (StoredChunk & { dims: number; vector: Uint8Array })[]).map((r) => {
        const buf = Buffer.from(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength);
        const vec = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        const { dims: _d, vector: _v, ...row } = r;
        return { id: r.id, vector: vec, row };
      });
    }
    const hits: Hit[] = [];
    for (const c of this.cache) {
      if (!opts.includeArchived && c.row.archived) continue;
      hits.push({ ...c.row, score: cosine(vector, c.vector) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  clear(): void {
    this.db.exec('DELETE FROM chunks');
    this.cache = null;
  }

  close(): void {
    this.db.close();
  }
}
