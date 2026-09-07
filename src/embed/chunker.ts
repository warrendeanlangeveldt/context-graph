import { topLevelSymbols } from '../index/symbols.js';

/**
 * Design spec §10.1: code is split at symbol boundaries, never by line count; prose by headings.
 * The symbol splitter is the plugin's own parser (index/symbols.ts), which is exact for ordinary
 * TypeScript and JavaScript and falls back to fixed windows elsewhere.
 */
export interface Chunk {
  id: string;
  kind: 'code' | 'doc' | 'decision' | 'constraint';
  ref: string;
  path?: string;
  start?: number;
  end?: number;
  text: string;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const DOC_EXT = /\.(md|mdx|markdown|txt|rst|adoc)$/;
const MAX_CHARS = 1600;

export function chunkFile(path: string, content: string): Chunk[] {
  if (CODE_EXT.test(path)) return chunkCode(path, content);
  if (DOC_EXT.test(path)) return chunkDoc(path, content);
  return chunkWindows(path, content, 'doc');
}

function chunkCode(path: string, content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  const spans = topLevelSymbols(content);
  if (!spans.length) return chunkWindows(path, content, 'code');
  const out: Chunk[] = [];
  for (const s of spans) {
    const text = lines.slice(s.start - 1, s.end).join('\n');
    if (!text.trim()) continue;
    for (const piece of splitLong(text)) {
      out.push({ id: `${path}#${s.name}${piece.index ? `~${piece.index}` : ''}`, kind: 'code', ref: `${path}#${s.name}`, path, start: s.start, end: s.end, text: piece.text });
    }
  }
  return out;
}

function chunkDoc(path: string, content: string): Chunk[] {
  const out: Chunk[] = [];
  const lines = content.split(/\r?\n/);
  let heading = '';
  let buf: string[] = [];
  let start = 1;
  const flush = (end: number): void => {
    const text = buf.join('\n').trim();
    if (text) {
      for (const piece of splitLong(text)) {
        out.push({ id: `${path}:${start}${piece.index ? `~${piece.index}` : ''}`, kind: 'doc', ref: `${path}:${start}${heading ? ` ${heading}` : ''}`, path, start, end, text: piece.text });
      }
    }
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^#{1,6}\s/.test(l)) {
      flush(i);
      heading = l.replace(/^#+\s*/, '').trim();
      start = i + 1;
    }
    buf.push(l);
  }
  flush(lines.length);
  return out;
}

function chunkWindows(path: string, content: string, kind: 'code' | 'doc'): Chunk[] {
  const lines = content.split(/\r?\n/);
  const out: Chunk[] = [];
  const size = 60;
  for (let i = 0; i < lines.length; i += size) {
    const text = lines.slice(i, i + size).join('\n');
    if (!text.trim()) continue;
    out.push({ id: `${path}:${i + 1}`, kind, ref: `${path}:${i + 1}`, path, start: i + 1, end: Math.min(i + size, lines.length), text });
  }
  return out;
}

function splitLong(text: string): { index: number; text: string }[] {
  if (text.length <= MAX_CHARS) return [{ index: 0, text }];
  const out: { index: number; text: string }[] = [];
  const lines = text.split('\n');
  let cur: string[] = [];
  let len = 0;
  let index = 0;
  for (const l of lines) {
    if (len + l.length > MAX_CHARS && cur.length) { out.push({ index: index++, text: cur.join('\n') }); cur = []; len = 0; }
    cur.push(l);
    len += l.length + 1;
  }
  if (cur.length) out.push({ index, text: cur.join('\n') });
  return out;
}
