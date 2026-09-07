import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Envelope } from '../observe/event.js';
import { startServer, type RunningServer } from './server.js';

describe('event server', () => {
  let home: string;
  let server: RunningServer;
  const prev = process.env.CTX_HOME;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    server = await startServer({ port: 0, viewDir: join(home, 'no-view') });
  });
  afterEach(async () => { await server.close(); if (prev === undefined) delete process.env.CTX_HOME; else process.env.CTX_HOME = prev; });

  const env = (t: Envelope['t'], session: string, branch: string, p: unknown, who = 'w/claude'): Envelope => ({ t, ts: new Date().toISOString(), session, who, branch, harness: 'test', p });
  const post = (path: string, body: unknown): Promise<Response> => fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = async <T>(path: string): Promise<T> => (await (await fetch(`http://127.0.0.1:${server.port}${path}`)).json()) as T;

  it('ingests, streams with sequence numbers, and answers live queries with cross-branch conflicts', async () => {
    const received: Envelope[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/r1/stream`);
    ws.on('message', (m) => received.push(JSON.parse(String(m)) as Envelope));
    await new Promise<void>((res) => ws.on('open', () => res()));
    await new Promise((r) => setTimeout(r, 50));

    await post('/v1/r1/observe', [
      env('session', 's1', 'feature/a', { kind: 'start', cwd: home, arm: 'on' }),
      env('touch', 's1', 'feature/a', { path: 'src/x.ts', mode: 'full', tool: 'Read', origin: 'main' }),
      env('decision', 's1', 'feature/a', { kind: 'D', id: 'd-p1', date: '2026-09-07', who: 'w/claude', sha: '-', branch: 'feature/a', node: 'src/x.ts', serves: 'k.one', overrides: 'k.two', text: 'moved it', line: 0 }),
    ]);
    await post('/v1/r1/observe', [
      env('session', 's2', 'feature/b', { kind: 'start', cwd: home, arm: 'on' }, 'm/codex'),
      env('decision', 's2', 'feature/b', { kind: 'D', id: 'd-p2', date: '2026-09-07', who: 'm/codex', sha: '-', branch: 'feature/b', node: 'src/x.ts', serves: 'k.two', text: 'kept it', line: 0 }, 'm/codex'),
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const types = received.map((e) => e.t);
    expect(types).toEqual(['ready', 'session', 'touch', 'decision', 'session', 'decision', 'finding']);
    const seqs = received.filter((e) => 'seq' in e).map((e) => (e as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const finding = received.find((e) => e.t === 'finding')!.p as { rule: string; constraint: string; branches: string[] };
    expect(finding).toMatchObject({ rule: 'live-opposed-arrows', constraint: 'k.two', branches: ['feature/b', 'feature/a'] });

    const live = await get<{ provisional: { id: string; conflict: boolean; branch: string }[]; touches: { who: string; mode: string }[] }>(`/v1/r1/live?nodes=${encodeURIComponent('src/x.ts,L:src,k.two')}&path=src/x.ts&branch=feature/b&session=s2`);
    expect(live.provisional).toHaveLength(1);
    expect(live.provisional[0]).toMatchObject({ id: 'd-p1', branch: 'feature/a', conflict: true });
    expect(live.touches).toEqual([{ who: 'w/claude', session: 's1', mode: 'full', age: '0m ago' }]);

    const sessions = await get<{ session: string; events: number }[]>('/v1/r1/sessions');
    expect(sessions.map((s) => s.session).sort()).toEqual(['s1', 's2']);
    const repos = await get<{ hash: string; provisional: number }[]>('/v1/repos');
    expect(repos[0]).toMatchObject({ hash: 'r1', provisional: 2 });

    const retired = await (await post('/v1/r1/provisional/retire', { branch: 'feature/a' })).json();
    expect(retired).toEqual({ retired: 1 });
    ws.close();
  });

  it('drops the second copy of an event that arrives by both the POST and the file-tail path, and tells clients its boot id', async () => {
    const received: (Envelope & { boot?: number; seq?: number })[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/r2/stream`);
    ws.on('message', (m) => received.push(JSON.parse(String(m)) as Envelope));
    await new Promise<void>((res) => ws.on('open', () => res()));
    await new Promise((r) => setTimeout(r, 50));
    const touch = env('touch', 's9', 'main', { path: 'src/y.ts', mode: 'full', tool: 'Read', origin: 'main' });
    await post('/v1/r2/observe', [touch]);
    await post('/v1/r2/observe', [touch, { ...touch, ts: '2026-09-07T00:00:00.001Z' }]);
    await new Promise((r) => setTimeout(r, 100));
    const ready = received.find((e) => e.t === 'ready');
    expect(typeof ready?.boot).toBe('number');
    expect(received.filter((e) => e.t === 'touch').map((e) => e.seq)).toEqual([1, 2]);
    const events = (await get('/v1/r2/events')) as { t: string }[];
    expect(events.filter((e) => e.t === 'touch')).toHaveLength(2);
    ws.close();
  });

  it('serves the API explanation page when the view is not built and rejects a bad token in hosted mode', async () => {
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    expect(html).toContain('The synapse view has not been built');
    const hosted = await startServer({ port: 0, hosted: true, token: 'secret', viewDir: join(home, 'none') });
    try {
      expect((await fetch(`http://127.0.0.1:${hosted.port}/v1/repos`)).status).toBe(401);
      const ok = await fetch(`http://127.0.0.1:${hosted.port}/v1/repos`, { headers: { authorization: 'Bearer secret' } });
      expect(ok.status).toBe(200);
    } finally { await hosted.close(); }
  });
});
