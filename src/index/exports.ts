/**
 * What a JavaScript or TypeScript file exposes to its importers, as the declaration lines that say so.
 * An edit that removes or alters one of these can break an importer; one that only adds exports cannot.
 * The first line of a declaration carries its name and usually its signature, which is the part callers
 * depend on; that is what is compared.
 */
const EXPORT_LINE = /^\s*(export\b.*|module\.exports\b.*|exports\.[A-Za-z_$][\w$]*\s*=.*)$/gm;

export function exportSignatures(source: string): string[] {
  return [...source.matchAll(EXPORT_LINE)].map((m) => m[1]!.replace(/\s+/g, ' ').replace(/\s*\{\s*$/, '').trim());
}

/** Export declarations present before and missing or different after: what an importer might have relied on. */
export function changedExports(before: string, after: string): string[] {
  const now = new Set(exportSignatures(after));
  return exportSignatures(before).filter((s) => !now.has(s));
}

/** The file's text after an edit tool call, when the call says enough to know it. */
export function textAfterEdit(before: string, edits: { old: string; new: string; all?: boolean }[]): string {
  let text = before;
  for (const e of edits) {
    if (!e.old) continue;
    text = e.all ? text.split(e.old).join(e.new) : text.replace(e.old, () => e.new);
  }
  return text;
}
