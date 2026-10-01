import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installCli } from '../install/install.js';
import { isOnPath, localiseCommands, scriptCommand } from './cli.js';

describe('ctx on the command line', () => {
  it('rewrites ctx commands to the running script when ctx is not installed, and leaves other text alone', () => {
    const cmd = scriptCommand('/opt/plugins/context-graph/0.2.3/ctx.mjs');
    expect(cmd).toBe('node /opt/plugins/context-graph/0.2.3/ctx.mjs');
    const text = 'Write its card (MCP tool `card`, or ctx card <path> --text "...") and run `ctx record --node a`. The ctx graph is fine; ctxcard is not a command.';
    expect(localiseCommands(text, cmd)).toBe('Write its card (MCP tool `card`, or node /opt/plugins/context-graph/0.2.3/ctx.mjs card <path> --text "...") and run `node /opt/plugins/context-graph/0.2.3/ctx.mjs record --node a`. The ctx graph is fine; ctxcard is not a command.');
    expect(localiseCommands(text, 'ctx')).toBe(text);
  });

  it('quotes a script path that needs it, so the command still runs', () => {
    expect(scriptCommand("/Users/a b/it's/ctx.mjs")).toBe(`node '/Users/a b/it'\\''s/ctx.mjs'`);
  });

  it('finds an executable on the PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-path-'));
    writeFileSync(join(dir, 'ctx'), '#!/bin/sh\n');
    expect(isOnPath('ctx', dir)).toBe(false);
    chmodSync(join(dir, 'ctx'), 0o755);
    expect(isOnPath('ctx', dir)).toBe(true);
  });

  it('installs a launcher that runs the copy it was installed from, or follows the plugin when installed from it', () => {
    const home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    const bin = join(home, 'bin');
    const fromClone = installCli({ binDir: bin, script: '/src/context-graph/dist/cli/main.js', home });
    const launcher = readFileSync(join(bin, 'ctx'), 'utf8');
    expect(statSync(join(bin, 'ctx')).mode & 0o111).toBeTruthy();
    expect(launcher).toContain('"/src/context-graph/dist/cli/main.js"');
    expect(launcher).not.toContain('installed_plugins.json');
    expect(fromClone.notes.join(' ')).toContain('is not on your PATH');
    const cache = join(home, '.claude', 'plugins', 'cache', 'context-graph', 'context-graph', '0.2.3');
    mkdirSync(cache, { recursive: true });
    installCli({ binDir: bin, script: join(cache, 'ctx.mjs'), home });
    expect(readFileSync(join(bin, 'ctx'), 'utf8')).toContain('installed_plugins.json');
  });
});
