// Read-assist and transcript tags (docs/specs/06-read-assist.md, 09-panes.md VIEW-4), pure. An edit the
// hooks refuse for unread files is drawn as a card with the reading list and the agent's progress
// through it; the agent is told what to read. Progress comes only from the agent's own full reads, as
// ctx judges them: the mod never reads on its behalf or marks anything understood.

const HEAD = 'Context Graph: read before you edit.';

/**
 * The reading list in a read-before-edit refusal: { edit, files } for the first edit it names (the
 * one refused), or null when the text isn't one.
 */
export function readingList(text) {
  if (typeof text !== 'string' || !text.includes(HEAD)) return null;
  const lines = text.slice(text.indexOf(HEAD)).split('\n');
  const at = lines.findIndex((l) => /^Before editing \S+, /.test(l));
  if (at < 0) return null;
  const edit = lines[at].match(/^Before editing (\S+?),/)[1];
  const files = [];
  for (const l of lines.slice(at + 1)) {
    const m = l.match(/^\s+- (\S+?): /);
    if (!m) break;
    files.push(m[1]);
  }
  return files.length ? { edit, files } : null;
}

/** ASSIST-1: what the agent is told: "Read src/b.ts and src/c.ts in full, then edit src/a.ts again." */
export function readingMessage({ edit, files }) {
  const list = files.length > 1 ? `${files.slice(0, -1).join(', ')} and ${files.at(-1)}` : files[0];
  return `Read ${list} in full, then edit ${edit} again.`;
}

/** ASSIST-2: "1 of 2 read", or "understood" once nothing is missing. `missing` is ctx's list, or null before it's read. */
export function progressText({ files }, missing) {
  if (!missing) return `0 of ${files.length} read`;
  const left = files.filter((f) => missing.includes(f)).length;
  return left ? `${files.length - left} of ${files.length} read` : 'understood';
}

/** ASSIST-1, ASSIST-2: the refused edit's card: what to read, each ticked once read, and the progress. */
export function assistCard(assist, { Box, Text }) {
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const done = assist.missing && progressText(assist, assist.missing) === 'understood';
  return Box({
    key: `assist-${assist.id}`,
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: done ? 'green' : 'yellow',
    paddingX: 1,
    children: [
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          text(`Read before editing ${assist.edit}`, { bold: true }),
          text(progressText(assist, assist.missing), { color: done ? 'green' : 'yellow' }),
        ],
      }),
      ...assist.files.map((f) => {
        const read = assist.missing ? !assist.missing.includes(f) : false;
        return text(`${read ? '✓' : '○'} ${f}`, read ? { dimColor: true } : {});
      }),
      text(assist.agentType ? `${assist.agentType} was told: ${readingMessage(assist)}` : readingMessage(assist), { dimColor: true }),
    ],
  });
}

/** VIEW-4: an edit's tag on its tool row: "not understood" when refused for unread files, "card owed" while one is. */
export function editTag(row, Text) {
  if (!row) return null;
  return row.refused
    ? Text({ key: 'tag', color: 'yellow', children: ['  not understood'] })
    : row.owed
      ? Text({ key: 'tag', color: 'yellow', children: ['  card owed'] })
      : null;
}
