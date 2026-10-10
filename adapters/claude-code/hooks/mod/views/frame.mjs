// Panes v2's frame for the Context pane (docs/specs/09-panes.md, VIEW-1 and VIEW-5): the graph's health
// as a header and a band line, the tabs, and the keys. Pure: the mod passes what it read from ctx and
// the pane's own state, and the handlers that act.

/** The tabs, on 1 to 4. */
export const TABS = [
  { id: 'file', label: 'File', hotkey: '1' },
  { id: 'proposals', label: 'Proposals', hotkey: '2' },
  { id: 'coverage', label: 'Coverage', hotkey: '3' },
  { id: 'map', label: 'Map', hotkey: '4' },
];

/** The pane's own state, kept by the mod between draws: the tab, the selection in it (none until j or k), and where Esc goes. */
export const DEFAULT_UI = { tab: 'file', selected: -1, back: [], mapModule: null };

/** The selection after a move of `step` in a list of `n`: from none, j takes the first and k the last. */
export const moved = (selected, step, n) => (!n ? -1 : selected < 0 ? (step > 0 ? 0 : n - 1) : (selected + step + n) % n);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * VIEW-1: the graph's health from `ctx cards --json` (fresh, stale, missing), the session's cards owed,
 * the proposals waiting, and the rules flagged as overridden: { carded, owed, proposals, flagged, level,
 * glyph, text }. Amber with anything owed or a flagged rule; red with 5 or more owed or 3 or more
 * flagged. The carded share is shown, not judged: a brownfield project starts at 0% and that's fine.
 */
export function healthOf({ cards = null, owed = 0, proposals = 0, flagged = 0 }) {
  const total = cards ? cards.fresh.length + cards.stale.length + cards.missing.length : 0;
  const carded = total ? Math.round((cards.fresh.length / total) * 100) : null;
  const level =
    owed >= 5 || flagged >= 3 ? 'red' : owed || flagged ? 'amber' : 'good';
  const glyph = { good: '☀', amber: '⛅', red: '⛈' }[level];
  const parts = [
    ...(carded !== null ? [`${carded}% carded`] : []),
    plural(owed, 'owed', 'owed'),
    plural(proposals, 'proposal', 'proposals'),
    ...(flagged ? [plural(flagged, 'rule overridden', 'rules overridden')] : []),
  ];
  return { carded, owed, proposals, flagged, level, glyph, text: `${glyph} ${parts.join(' · ')}` };
}

const LEVEL_COLOR = { good: 'green', amber: 'yellow', red: 'red' };

/** VIEW-1: the band's line, while something waits on the person or the health isn't good; else none. */
export function bandHealth(health) {
  if (!health) return null;
  if (health.level === 'good' && !health.proposals && !health.owed) return null;
  return { text: health.text, color: LEVEL_COLOR[health.level] };
}

/**
 * The frame: the header, the person's last act, the tabs and the tab's body. `body(tab)` draws a tab's
 * content (an array of nodes); `keys` are the tab's own keys, drawn under it. `on`: onTab(id), onMove(step),
 * onOpen(), onSettings().
 */
export function frame({ health, notice, ui, body, keys = [] }, { Box, Text, Button }, on) {
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const header = Box({
    key: 'header',
    flexDirection: 'row',
    columnGap: 2,
    children: [
      text(health.text, { color: LEVEL_COLOR[health.level] }),
      Button({ key: 'open-settings', label: 'Settings', plain: true, dimColor: true, onPress: on.onSettings }),
    ],
  });
  const tabs = Box({
    key: 'tabs',
    flexDirection: 'row',
    columnGap: 1,
    children: TABS.map((t) =>
      Button({
        key: `tab-${t.id}`,
        label: t.label,
        hotkey: t.hotkey,
        ...(ui.tab === t.id ? { variant: 'primary' } : { dimColor: true }),
        onPress: () => on.onTab(t.id),
      }),
    ),
  });
  // VIEW-5: j/k move in a list, Enter (or o) opens what's selected; Esc goes back, then closes.
  const nav = Box({
    key: 'nav',
    flexDirection: 'row',
    columnGap: 1,
    children: [
      Button({ key: 'move-next', label: 'Next', hotkey: 'j', plain: true, onPress: () => on.onMove(1) }),
      Button({ key: 'move-prev', label: 'Previous', hotkey: 'k', plain: true, onPress: () => on.onMove(-1) }),
      Button({ key: 'open-selected', label: 'Open', hotkey: 'o', plain: true, onPress: on.onOpen }),
      ...keys,
      text(ui.back.length ? 'Esc: back' : 'Esc: close', { dimColor: true }),
    ],
  });
  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      header,
      ...(notice ? [text(notice.text, { color: notice.ok ? 'green' : 'red' })] : []),
      tabs,
      ...body(ui.tab),
      nav,
    ],
  });
}

/** VIEW-5: the person's Escape goes back to where they came from while there is somewhere; then it closes. */
export const closeGoesBack = (e, paneId, ui) => e.id === paneId && e.origin?.kind === 'person' && ui.back.length > 0;
