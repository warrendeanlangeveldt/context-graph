import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { GraphRecord } from './records.js';

/** Serialise a record in the canonical form the parser reads back. */
export function formatRecord(r: GraphRecord): string {
  switch (r.kind) {
    case 'M': return `M ${r.glob} ${r.logical}`;
    case 'L': return `L ${r.id} ${r.name}`;
    case 'C': return `C ${r.id} ${r.name}${r.adr ? ` adr:${r.adr}` : ''}${r.proposed ? ' proposed' : ''}`;
    case 'E': return `E ${r.from} ${r.rel} ${r.to}${r.proposed ? ' proposed' : ''}`;
    case 'K': return `K ${r.mode} ${r.id} ${r.attachedTo} ${r.text}${r.test ? ` test:${r.test}` : ''}${r.from ? ` from:${r.from}` : ''}`;
    case 'D': {
      const arrow = r.serves.startsWith('C:') ? `->C ${r.serves.slice(2)}` : `->K ${r.serves}`;
      const bang = r.overrides ? ` !K ${r.overrides}` : '';
      return `D ${r.id} ${r.date} ${r.who} ${r.sha} ${r.branch} ${r.node} ${arrow}${bang} ${r.text}`;
    }
    case 'S': return `S ${r.newId} ${r.oldId}`;
    case 'Z': return `Z ${r.target} ${r.date} ${r.who}${r.succ ? ` succ:${r.succ}` : ''} ${r.reason}`;
    case 'A': return `A ${r.alias} ${r.node}`;
    case 'R': return `R ${r.role} ${r.heuristic}`;
  }
}

/** Append a record on its own line, adding a newline first if the file does not end with one. */
export function appendRecord(file: string, r: GraphRecord): void {
  let prefix = '';
  if (existsSync(file)) {
    const cur = readFileSync(file, 'utf8');
    if (cur.length > 0 && !cur.endsWith('\n')) prefix = '\n';
  }
  appendFileSync(file, prefix + formatRecord(r) + '\n', 'utf8');
}
