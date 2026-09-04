/**
 * What `framewatch_snapshot` does with the tree Playwright hands it.
 *
 * Playwright's AI-mode aria snapshot is YAML-ish text, one element per line,
 * indented by depth, each carrying a `[ref=eN]` that `aria-ref=eN` resolves
 * back to the element. Everything here is text in, text out — no browser —
 * so the counting, the filtering and the truncation can be tested in
 * milliseconds against a tree written by hand.
 */

/** Roles a person can act on. A line with one of these, or a pointer cursor, is "interactive". */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
]);

const REF_PATTERN = /\[ref=(e\d+)\]/;
const LINE_PATTERN = /^(\s*)- (\S+)(.*)$/;

/** A bare ref as the caller writes it: `e8`. */
export function isRef(value: string): boolean {
  return /^e\d+$/.test(value);
}

/** The Playwright selector that resolves a snapshot ref. */
export function refSelector(ref: string): string {
  return `aria-ref=${ref}`;
}

export interface SnapshotCounts {
  /** Lines carrying a ref — every element the snapshot can name. */
  elements: number;
  /** Of those, the ones a person can act on. */
  interactive: number;
}

export function countSnapshot(tree: string): SnapshotCounts {
  let elements = 0;
  let interactive = 0;
  for (const line of tree.split("\n")) {
    if (!REF_PATTERN.test(line)) continue;
    elements++;
    if (isInteractiveLine(line)) interactive++;
  }
  return { elements, interactive };
}

/**
 * The interactive lines only, flattened to one level and stripped of the
 * trailing colon a parent line carries. A link's `/url` child, which is the
 * only child worth keeping, is folded onto the link's own line.
 */
export function interactiveOnly(tree: string): string {
  const lines = tree.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!REF_PATTERN.test(line) || !isInteractiveLine(line)) continue;
    let text = line.trim().replace(/:$/, "");
    const url = childUrl(lines, i);
    if (url !== undefined) text += ` → ${url}`;
    out.push(text);
  }
  return out.join("\n");
}

export interface TruncatedSnapshot {
  text: string;
  /** Whole lines dropped from the end to fit. */
  cut_lines: number;
}

/** Cut the tree to at most `maxChars`, on a line boundary, and say how many lines went. */
export function truncateSnapshot(tree: string, maxChars: number): TruncatedSnapshot {
  if (tree.length <= maxChars) return { text: tree, cut_lines: 0 };
  const lines = tree.split("\n");
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const next = length + line.length + (kept.length > 0 ? 1 : 0);
    if (next > maxChars) break;
    kept.push(line);
    length = next;
  }
  return { text: kept.join("\n"), cut_lines: lines.length - kept.length };
}

function isInteractiveLine(line: string): boolean {
  const match = LINE_PATTERN.exec(line);
  if (!match) return false;
  const role = match[2];
  if (INTERACTIVE_ROLES.has(role)) return true;
  return line.includes("[cursor=pointer]");
}

/** The `/url` line directly under `index`, when the element has one. */
function childUrl(lines: string[], index: number): string | undefined {
  const own = lines[index].search(/\S/);
  for (let j = index + 1; j < lines.length; j++) {
    const line = lines[j];
    const indent = line.search(/\S/);
    if (indent === -1 || indent <= own) break;
    const url = /^\s*- \/url: (.*)$/.exec(line);
    if (url) return url[1].trim();
  }
  return undefined;
}
