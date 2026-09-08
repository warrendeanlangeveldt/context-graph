import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ancestorPids, resolveSession } from './session.js';

describe('session resolution for processes the harness did not tell', () => {
  const prev = { CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID, CTX_SESSION: process.env.CTX_SESSION };
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('walks up to a real parent', () => {
    const chain = ancestorPids();
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0]).toBe(process.ppid);
  });

  it('prefers the environment, then a shared ancestor, then the most recent harness session, then the fallback', () => {
    delete process.env.CLAUDE_SESSION_ID; delete process.env.CTX_SESSION;
    const stateDir = mkdtempSync(join(tmpdir(), 'ctx-sess-'));
    expect(resolveSession('/r', 'mcp', { stateDir, ancestors: [1, 2] })).toBe('mcp');
    writeFileSync(join(stateDir, 'old-session.json'), JSON.stringify({ pids: [500, 400], pending: {} }));
    writeFileSync(join(stateDir, 'new-session.json'), JSON.stringify({ pids: [700, 600], pending: {} }));
    writeFileSync(join(stateDir, 'mcp.json'), JSON.stringify({ pids: [700], pending: {} }));
    const t = Date.now();
    utimesSync(join(stateDir, 'old-session.json'), new Date(t - 3 * 3600_000), new Date(t - 3 * 3600_000));
    utimesSync(join(stateDir, 'new-session.json'), new Date(t - 60_000), new Date(t - 60_000));
    expect(resolveSession('/r', 'mcp', { stateDir, ancestors: [9, 400], now: t })).toBe('old-session');
    expect(resolveSession('/r', 'mcp', { stateDir, ancestors: [1, 2], now: t })).toBe('new-session');
    utimesSync(join(stateDir, 'new-session.json'), new Date(t - 5 * 3600_000), new Date(t - 5 * 3600_000));
    expect(resolveSession('/r', 'cli', { stateDir, ancestors: [1, 2], now: t })).toBe('cli');
    process.env.CTX_SESSION = 'told';
    expect(resolveSession('/r', 'cli', { stateDir, ancestors: [400], now: t })).toBe('told');
    mkdirSync(join(stateDir, 'unused'));
  });
});
