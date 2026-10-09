// The Settings view (docs/specs/09-panes.md, VIEW-6): Context Graph's harness settings from `ctx settings
// --json`, each with a control; a change asks the person's reason before anything is written.

export const SETTINGS_ID = 'context-graph-settings';

const MODELS = ['', 'haiku', 'sonnet', 'opus'];
const shown = (v) => (v === '' ? "the session's" : v === true ? 'on' : v === false ? 'off' : String(v));

/** The value to show a setting as and the choices it offers: on/off, a model, or a typed number. */
function control(row, { Select, Input }, onChoose) {
  if (typeof row.default === 'boolean')
    return Select({
      key: `set-${row.key}`,
      label: '',
      value: String(row.value),
      options: [true, false].map((v) => ({ value: String(v), label: shown(v) })),
      onSelect: (v) => onChoose(row.key, v),
    });
  if (row.key.endsWith('_model')) {
    // A model given by its id is kept among the choices, as the one chosen.
    const choices = MODELS.includes(row.value) ? MODELS : [...MODELS, row.value];
    return Select({
      key: `set-${row.key}`,
      label: '',
      value: row.value,
      options: choices.map((v) => ({ value: v, label: shown(v) })),
      onSelect: (v) => onChoose(row.key, v),
    });
  }
  return Input({ key: `set-${row.key}`, label: '', value: String(row.value), submitLabel: 'Set', onSubmit: (v) => onChoose(row.key, v.trim()) });
}

/**
 * The view: a row per setting, and, once one is changed, a confirmation with the person's reason.
 * `pending` is { key, value, reason, error } or null; handlers: onChoose(key, value), onReason(text),
 * onConfirm(reason), onCancel().
 */
export function settingsView(rows, pending, els, { onChoose, onReason, onConfirm, onCancel }) {
  const { Box, Text, Input, Button } = els;
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const confirm = pending
    ? [
        Box({
          key: 'settings-confirm',
          flexDirection: 'column',
          borderStyle: 'round',
          paddingX: 1,
          children: [
            text(`Set ${pending.key} to ${shown(pending.value === '' ? '' : pending.value === 'true' ? true : pending.value === 'false' ? false : pending.value)}?`, { bold: true }),
            text('It goes into .ctx/config.toml; where code-kit guards that file, its log keeps your reason.', { dimColor: true }),
            Input({ key: 'settings-reason', label: 'Reason', value: pending.reason, submitLabel: 'Change it', autoFocus: true, onInput: onReason, onSubmit: onConfirm }),
            ...(pending.error ? [text(pending.error, { color: 'red' })] : []),
            Box({
              flexDirection: 'row',
              columnGap: 2,
              children: [
                Button({ key: 'settings-ok', label: 'Change it', onPress: () => onConfirm(pending.reason) }),
                Button({ key: 'settings-cancel', label: 'Cancel', onPress: onCancel }),
              ],
            }),
          ],
        }),
      ]
    : [];
  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      text('CONTEXT GRAPH HARNESS', { bold: true, color: 'cyan' }),
      ...confirm,
      Box({
        flexDirection: 'column',
        children: rows.map((r) =>
          Box({
            key: `setting-${r.key}`,
            flexDirection: 'column',
            children: [
              Box({
                flexDirection: 'row',
                columnGap: 2,
                children: [
                  Box({ width: 22, children: [text(r.key, { bold: true })] }),
                  control(r, els, onChoose),
                  ...(r.value !== r.default ? [text(`default ${shown(r.default)}`, { dimColor: true })] : []),
                ],
              }),
              text(`  ${r.about}`, { dimColor: true }),
            ],
          }),
        ),
      }),
    ],
  });
}
