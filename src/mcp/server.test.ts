import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer } from './server.js';

const GRAPH = 'M src/** L:src\nM ** L:repo\nL L:repo Repo\nL L:src Source\nE L:src in L:repo\nK G src.pure L:src no side effects at import\n';
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

describe('the MCP server, through a real MCP client', () => {
  let repo: string;
  let client: Client;
  const prevHome = process.env.CTX_HOME;

  beforeEach(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-mcp-')));
    process.env.CTX_HOME = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ agent: 'test', repo }).connect(serverSide);
    client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
  });
  afterEach(async () => {
    await client.close();
    if (prevHome === undefined) delete process.env.CTX_HOME;
    else process.env.CTX_HOME = prevHome;
  });

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return r.content.map((c) => c.text).join('\n');
  };

  it("reports the package's version", () => {
    expect(client.getServerVersion()).toEqual({ name: 'ctx', version: pkg.version });
  });

  it('lists every tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['applies', 'card', 'check', 'coverage', 'history', 'hydrate', 'propose', 'record', 'slice', 'slice_patch', 'why']);
  });

  it('serves the slice, records a decision and writes a card', async () => {
    expect(await call('check')).toBe('ok: 1 constraints, 0 decisions, 2 modules');
    expect(await call('slice', { path: 'src/a.ts' })).toContain('no side effects at import  [G src.pure]');
    expect(await call('record', { node: 'src/a.ts', serves: 'K:nope', text: 'x' })).toContain('applicable: src/a.ts, L:src, L:repo, src.pure');
    expect(await call('record', { node: 'src/a.ts', serves: 'src.pure', text: 'a stays a constant' })).toMatch(/^recorded d-\w+ on src\/a\.ts -> src\.pure/);
    expect(await call('propose', { target: 'src/a.ts', text: 'Dates are stored in UTC' })).toMatch(/^proposed \S+ on L:src: Dates are stored in UTC/);
    expect(await call('propose', { target: 'src/a.ts', text: 'Dates are stored in UTC' })).toMatch(/^rejected: L:src already has this rule proposed/);
    expect(await call('why', { node: 'src/a.ts' })).toContain('a stays a constant');
    expect(await call('card', { path: 'src/a.ts', text: 'Holds a; importing it runs nothing.' })).toMatch(/^card src\/a\.ts @ \w+/);
    expect(readFileSync(join(repo, '.ctx/cards.ctx'), 'utf8')).toContain('Holds a; importing it runs nothing.');
  });
});
