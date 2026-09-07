import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Graph } from '../graph/graph.js';
import { parseText } from '../graph/parse.js';
import type { CRecord, ERecord, GraphRecord, KRecord, LRecord, MRecord, RRecord } from '../graph/records.js';
import { formatRecord } from '../graph/write.js';

/**
 * Style packs (design spec §16.1). A pack is a `.ctx` file whose nodes are role placeholders.
 * Detection binds roles to a repository's logical nodes; a bound pack instantiates its
 * constraints as proposals stamped with their provenance. Export turns a ratified graph back
 * into a pack, which is the reuse path across repositories in one organisation.
 *
 * Role heuristics (the `R` record):
 *   dir:<name>|<name>     a module whose directory name matches one of the names
 *   file:<glob>           a module containing a file that matches (binds to the containing module, else the root)
 *   root                  the repository root module
 */
export interface Pack {
  name: string;
  version: string;
  file: string;
  roles: RRecord[];
  records: GraphRecord[];
}

export interface Binding { role: string; logical: string; evidence: string }

export interface Instantiation {
  pack: Pack;
  bindings: Binding[];
  unbound: string[];
  records: GraphRecord[];
}

export function packsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packs');
}

export function loadPack(file: string): Pack {
  const text = readFileSync(file, 'utf8');
  const version = /^#\s*version:\s*(\S+)/m.exec(text)?.[1] ?? '1';
  const records = parseText(text, file);
  return { name: basename(file, '.ctx'), version, file, roles: records.filter((r): r is RRecord => r.kind === 'R'), records: records.filter((r) => r.kind !== 'R') };
}

export function loadPacks(names: string[]): Pack[] {
  const dir = packsDir();
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir).filter((f) => f.endsWith('.ctx')).map((f) => join(dir, f));
  const wanted = names.includes('auto') ? all : all.filter((f) => names.includes(basename(f, '.ctx')));
  return wanted.map(loadPack);
}

/** Bind each role of a pack to logical nodes of the graph, honouring configured overrides. */
export function detectBindings(pack: Pack, graph: Graph, files: string[], overrides: Record<string, string> = {}): { bindings: Binding[]; unbound: string[] } {
  const bindings: Binding[] = [];
  const unbound: string[] = [];
  const modules = [...graph.logicals.values()];
  const globFor = (id: string): string | undefined => graph.mappings.find((m) => m.logical === id)?.glob;
  const dirNameOf = (id: string): string | undefined => {
    const g = globFor(id);
    if (!g) return undefined;
    const path = g.replace(/\/\*\*$/, '');
    return basename(path).toLowerCase();
  };
  for (const r of pack.roles) {
    const role = r.role.slice(1, -1);
    const override = overrides[`${pack.name}.${role}`];
    if (override) { bindings.push({ role, logical: override, evidence: 'configured' }); continue; }
    const h = r.heuristic.trim();
    let found: Binding[] = [];
    if (h.startsWith('dir:')) {
      const names = h.slice(4).split('|').map((s) => s.trim().toLowerCase());
      for (const m of modules) { const d = dirNameOf(m.id); if (d && names.includes(d)) found.push({ role, logical: m.id, evidence: `directory ${d}` }); }
    } else if (h.startsWith('file:')) {
      const glob = h.slice(5).trim();
      const hits = files.filter((f) => matches(glob, f));
      for (const f of hits.slice(0, 5)) {
        const m = graph.mapPath(f);
        if (m && !found.some((b) => b.logical === m.logical)) found.push({ role, logical: m.logical, evidence: `file ${f}` });
      }
    } else if (h === 'root') {
      const root = graph.mappings.find((m) => m.glob === '**')?.logical ?? modules[modules.length - 1]?.id;
      if (root) found = [{ role, logical: root, evidence: 'repository root' }];
    }
    if (!found.length) unbound.push(role);
    bindings.push(...found);
  }
  return { bindings, unbound };
}

/** Instantiate a pack's records against bindings. Constraints whose roles are all bound become proposals. */
export function instantiate(pack: Pack, bindings: Binding[], unbound: string[], today: string): Instantiation {
  const byRole = new Map<string, string[]>();
  for (const b of bindings) byRole.set(b.role, [...(byRole.get(b.role) ?? []), b.logical]);
  const records: GraphRecord[] = [];
  const stamp = `${pack.name}@${pack.version}`;
  const roleIn = (s: string): string[] => [...s.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const expand = (template: string): string[] => {
    // Every combination of bound modules for the roles in the template.
    let outs = [template];
    for (const role of new Set(roleIn(template))) {
      const targets = byRole.get(role);
      if (!targets?.length) return [];
      outs = outs.flatMap((o) => targets.map((t) => o.replaceAll(`{${role}}`, t)));
    }
    return outs;
  };
  const suffix = (s: string): string => s.replace(/^L:/, '').replace(/[^A-Za-z0-9]+/g, '-');

  for (const r of pack.records) {
    if (r.kind === 'C') { records.push({ ...r, proposed: true, since: today, line: 0 }); continue; }
    if (r.kind === 'K') {
      // A constraint whose text names a role nobody bound would read as a template; skip it.
      if (roleIn(r.text).some((role) => !byRole.get(role)?.length)) continue;
      const attached = expand(r.attachedTo);
      const rules = r.rule ? expand(r.rule) : [undefined];
      const many = attached.length > 1 || rules.length > 1;
      for (const a of attached) {
        for (const rule of rules) {
          if (rule && !rule.includes(a) && roleIn(r.attachedTo).length && roleIn(r.rule ?? '').length) continue;
          const id = many ? `${r.id}.${suffix(a)}${rule && rules.length > 1 ? `.${suffix(rule.split(':').pop() ?? '')}` : ''}` : r.id;
          const k: KRecord = { kind: 'K', mode: r.mode === 'E' ? 'G?' : r.mode === 'G' ? 'G?' : r.mode, id, attachedTo: a, text: r.text.replace(/\{[^}]+\}/g, (m) => byRole.get(m.slice(1, -1))?.[0] ?? m), from: stamp, since: today, line: 0 };
          if (r.test) k.test = r.test;
          if (rule) k.rule = rule;
          records.push(k);
        }
      }
      continue;
    }
    if (r.kind === 'E') {
      for (const from of expand(r.from)) for (const to of expand(r.to)) records.push({ kind: 'E', from, rel: r.rel, to, proposed: true, since: today, line: 0 });
    }
  }
  return { pack, bindings, unbound, records };
}

/** A ratified graph as a pack: modules become roles, constraints keep text and mode, decisions are dropped. */
export function exportPack(graph: Graph, name: string, version = '1'): string {
  const lines: string[] = [`# pack: ${name}`, `# version: ${version}`, `# exported from a ratified graph; roles are detected by directory name`];
  const roleOf = new Map<string, string>();
  for (const l of graph.logicals.values()) {
    const glob = graph.mappings.find((m) => m.logical === l.id)?.glob;
    const dir = glob ? basename(glob.replace(/\/\*\*$/, '')) : l.id.slice(2);
    const role = l.id.slice(2).replace(/[^A-Za-z0-9-]/g, '-');
    roleOf.set(l.id, role);
    lines.push(formatRecord({ kind: 'R', role: `{${role}}`, heuristic: glob === '**' ? 'root' : `dir:${dir}`, line: 0 }));
  }
  const sub = (s: string): string => s.replace(/L:[A-Za-z0-9_.-]+/g, (m) => (roleOf.has(m) ? `{${roleOf.get(m)}}` : m));
  for (const c of graph.concepts.values()) { const { proposed: _p, since: _s, ...rest } = c; lines.push(formatRecord({ ...rest, line: 0 })); }
  for (const e of graph.edges) if (e.rel === 'impl' && !e.proposed) lines.push(formatRecord({ kind: 'E', from: sub(e.from), rel: 'impl', to: e.to, line: 0 }));
  for (const k of graph.constraints.values()) {
    if (graph.isRetired(k.id) || k.mode === 'G?' || k.mode === 'R') continue;
    const rec: KRecord = { kind: 'K', mode: k.mode === 'E' ? 'G' : k.mode, id: k.id, attachedTo: sub(k.attachedTo), text: k.text, line: 0 };
    if (k.rule) rec.rule = sub(k.rule);
    lines.push(formatRecord(rec));
  }
  return lines.join('\n') + '\n';
}

export function writePack(graph: Graph, name: string, out: string): void {
  writeFileSync(out, exportPack(graph, name), 'utf8');
}

function matches(glob: string, path: string): boolean {
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
  return re.test(path);
}

export type { CRecord, ERecord, LRecord, MRecord };
