import type { WalkResult } from '../walker/walk.js';
import { MODE_RANK, type AccessMode, type Envelope, type Touch } from './event.js';

/** Per-edit coverage record (design spec §8.2): what applied versus what was in context. */
export interface CoverageRecord {
  path: string;
  applicable: string[];
  mapped: boolean;
  loaded: Record<string, AccessMode>;
  callers: string[];
  callers_loaded: number;
  callers_total: number;
  slice_injected: boolean;
  summarized_since: boolean;
  delegated: string[];
  /** Applicable file-level nodes never loaded in any mode. Logical and conceptual nodes are excluded: they are not files. */
  dark: string[];
}

export function computeCoverage(
  events: Envelope[],
  walk: WalkResult,
  callers: string[],
  sliceInjected: boolean,
): CoverageRecord {
  const loaded: Record<string, AccessMode> = {};
  const delegated = new Set<string>();
  let lastDirectTouchOfPath = -1;
  let lastCompact = -1;

  events.forEach((e, i) => {
    if (e.t === 'compact') { lastCompact = i; return; }
    if (e.t !== 'touch' && e.t !== 'edit') return;
    const p = e.p as Touch;
    const mode: AccessMode = p.origin === 'subagent' ? 'delegated' : p.mode;
    if (p.origin === 'subagent') delegated.add(p.path);
    const prev = loaded[p.path];
    // Later touches win ties, so an edit after a range read shows as the edit.
    if (!prev || MODE_RANK[mode] >= MODE_RANK[prev]) loaded[p.path] = mode;
    if (p.path === walk.path && p.origin === 'main' && (p.mode === 'full' || p.mode === 'range')) lastDirectTouchOfPath = i;
  });

  const summarized_since = lastCompact > lastDirectTouchOfPath && lastDirectTouchOfPath >= 0;
  if (summarized_since) loaded[walk.path] = 'summarized';

  const inContext = (p: string): boolean => {
    const m = loaded[p];
    return m === 'full' || m === 'range' || m === 'edit' || m === 'write';
  };
  const callers_loaded = callers.filter(inContext).length;
  const fileNodes = walk.nodes.filter((n) => !n.startsWith('L:') && !n.startsWith('C:')).map((n) => n.split('#')[0]!);
  const dark = [...new Set(fileNodes)].filter((n) => !loaded[n]);

  return {
    path: walk.path,
    applicable: walk.applicable,
    mapped: walk.mapped,
    loaded,
    callers,
    callers_loaded,
    callers_total: callers.length,
    slice_injected: sliceInjected,
    summarized_since,
    delegated: [...delegated],
    dark,
  };
}
