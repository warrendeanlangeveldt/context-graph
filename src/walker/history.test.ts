import { describe, expect, it } from 'vitest';
import { Graph } from '../graph/graph.js';
import { parseText } from '../graph/parse.js';
import { renderHistory } from './history.js';

const GRAPH = `
M api/src/core/** L:core
L L:core Engine
K G core.events L:core state changes go through events
A poller api/src/core/poller.ts
`;
const D = [
  'D d-0001 2026-09-01 w/claude aaaaaaa main api/src/core/poller.ts ->K core.events the poller acks only after the move succeeds, so a failed move cannot drop the message',
  'D d-0002 2026-09-08 w/claude - main api/src/core/poller.ts#drain ->K core.events !core.events legacy: drains through a direct write because the blackboard cannot batch',
  'D d-0003 2026-09-04 m/codex bbbbbbb main api/src/core/poller.ts ->K core.events retry count lives on the message, not the workspace',
  'D d-0004 2026-09-02 w/claude ccccccc main api/src/core/other.ts ->K core.events unrelated file',
].join('\n');

describe('read-time decision history', () => {
  const g = (): Graph => Graph.fromRecords(parseText(GRAPH + D, 'h'));

  it('says nothing about a file with no decisions', () => {
    expect(renderHistory(g(), 'api/src/core/untouched.ts')).toBeUndefined();
  });

  it('gives the file its own decisions, newest first, symbol-scoped ones included, overrides marked', () => {
    const h = renderHistory(g(), 'api/src/core/poller.ts')!;
    const lines = h.text.split('\n');
    expect(lines[0]).toBe('read poller');
    expect(h.decisions).toEqual(['d-0002', 'd-0003', 'd-0001']);
    expect(lines[1]).toBe('  decided  d-0002 09-08 w/claude  drain  !core.events  legacy: drains through a direct write because the blackboard cannot batch  (main provisional)');
    expect(lines[2]).toContain('d-0003 09-04 m/codex  retry count lives on the message');
    expect(lines[3]).toContain('(aaaaaaa)');
    expect(h.text).not.toContain('unrelated file');
  });

  it('caps the list and keeps the newest decision whatever the budget', () => {
    const capped = renderHistory(g(), 'api/src/core/poller.ts', { maxDecisions: 2 })!;
    expect(capped.decisions).toEqual(['d-0002', 'd-0003']);
    expect(capped.text).toContain('and 1 more: ctx history poller');
    const tiny = renderHistory(g(), 'api/src/core/poller.ts', { maxTokens: 1 })!;
    expect(tiny.decisions).toEqual(['d-0002']);
    expect(tiny.text).toContain('d-0002');
    expect(tiny.text).not.toContain('w/claude');
    expect(tiny.text).toContain('and 2 more');
  });
});
