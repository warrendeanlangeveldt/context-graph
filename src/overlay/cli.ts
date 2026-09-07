import { WebSocket } from 'ws';
import { openFromArgs, str, type Args } from '../cli/main.js';
import { loadConfig } from '../core/context.js';
import { repoHash, resolveGraphDir, findRepoRoot } from '../util/paths.js';
import { localServer, overlayTargets } from './client.js';
import { startServer } from './server.js';

export async function run(args: Args, env: { json: boolean }): Promise<number> {
  if (args.cmd === 'serve') {
    const repoOpt = str(args.flags.repo);
    const root = repoOpt ? findRepoRoot(repoOpt) : undefined;
    const cfg = loadConfig(root ? resolveGraphDir(root) : undefined);
    const hosted = args.flags.hosted === true;
    const port = Number(str(args.flags.port) ?? (hosted ? 7400 : cfg.serve.port));
    const register = args.flags['no-register'] !== true;
    const existing = !hosted && register && localServer();
    if (existing) { console.log(`a local server is already running on port ${existing.port} (pid ${existing.pid}); pass --no-register to start a second, unadvertised instance`); return 0; }
    const token = str(args.flags.token) ?? process.env.CTX_OVERLAY_TOKEN;
    const server = await startServer({ port, hosted, register, ...(token ? { token } : {}), bufferEvents: cfg.serve.bufferEvents, ...(root ? { repos: [root] } : {}), ...(str(args.flags.bind) ? { bind: str(args.flags.bind)! } : {}) });
    console.log(`ctx serve: ${hosted ? 'hosted' : 'local'} mode on http://${hosted ? '0.0.0.0' : '127.0.0.1'}:${server.port}  (view at /, API under /v1/)`);
    if (root) console.log(`  repository ${root} registered as ${repoHash(root)}`);
    if (hosted && !token) console.log('  warning: hosted mode without a token accepts anyone who can reach the port');
    const stop = (): void => { void server.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await new Promise<void>(() => undefined);
    return 0;
  }

  if (args.cmd === 'overlay') {
    const sub = args.positional[0];
    const ctx = openFromArgs(args);
    const hash = repoHash(ctx.root);
    const targets = overlayTargets(ctx);
    if (!targets.length) { console.error('no overlay reachable: start ctx serve, or set [overlay] url and [observe] forward = true'); return 1; }
    const t = targets[targets.length - 1]!;
    if (sub === 'tail') {
      const url = `${t.url.replace(/^http/, 'ws')}/v1/${hash}/stream?since=${Number.MAX_SAFE_INTEGER}${t.token ? `&token=${t.token}` : ''}`;
      const ws = new WebSocket(url);
      ws.on('message', (m) => {
        const e = JSON.parse(String(m)) as { t: string; p?: { rule?: string; message?: string } };
        if (e.t === 'finding' && e.p) process.stdout.write(`Context Graph: ${e.p.rule}: ${e.p.message}\n`);
      });
      ws.on('close', () => process.exit(0));
      ws.on('error', (e) => { console.error(e.message); process.exit(1); });
      await new Promise<void>(() => undefined);
      return 0;
    }
    if (sub === 'retire') {
      const branch = str(args.flags.branch);
      const ids = args.positional.slice(1);
      if (!branch && !ids.length) throw new Error('ctx overlay retire --branch <name> | <decision-id>...');
      const res = await fetch(`${t.url}/v1/${hash}/provisional/retire`, { method: 'POST', headers: { 'content-type': 'application/json', ...(t.token ? { authorization: `Bearer ${t.token}` } : {}) }, body: JSON.stringify({ ...(branch ? { branch } : {}), ...(ids.length ? { ids } : {}) }) });
      console.log(await res.text());
      return 0;
    }
    if (sub === 'status') {
      const res = await fetch(`${t.url}/v1/repos`, { headers: t.token ? { authorization: `Bearer ${t.token}` } : {} });
      const repos = (await res.json()) as unknown[];
      console.log(env.json ? JSON.stringify(repos, null, 2) : `${t.mode} overlay at ${t.url}: ${JSON.stringify(repos)}`);
      return 0;
    }
    throw new Error('ctx overlay tail | retire | status');
  }
  return 1;
}
