/**
 * Tiny unified-diff line parser — enough to render a `RunDiffFile.diff` string
 * (a real unified text diff produced server-side by `server/runDiff.ts`, via
 * jsdiff) as a colored, gutter-marked diff view. Deliberately NOT a full patch
 * parser: we only classify each physical line so the UI can tint it. Long lines
 * are preserved verbatim (the view scrolls them inside its own pane).
 */

export type DiffLineKind =
  | 'add'
  | 'del'
  | 'hunk'
  | 'meta'
  | 'context'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  gutter: string
}

/**
 * Classify one physical diff line, given whether we are already inside a hunk.
 * Classification is STATEFUL over hunk position: only the preamble (before the
 * first `@@`) may hold `---`/`+++`/`diff `/`index `/`Index:`/`===` headers, so
 * once inside a hunk a content line whose text merely begins with `--`/`++`
 * (a markdown `---` HR/frontmatter, a `-- comment`, a `++x`) is read by its
 * single leading marker char and keeps its del/add tint + stat.
 */
function classify(line: string, inHunk: boolean): DiffLine {
  if (line.startsWith('@@')) return { kind: 'hunk', text: line, gutter: '' }
  if (!inHunk) {
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('Index:') ||
      line.startsWith('===')
    )
      return { kind: 'meta', text: line, gutter: '' }
    return { kind: 'context', text: line, gutter: '' }
  }
  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1), gutter: '+' }
  if (line.startsWith('-')) return { kind: 'del', text: line.slice(1), gutter: '-' }
  if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1), gutter: '' }
  return { kind: 'context', text: line, gutter: '' }
}

/**
 * Split a unified-diff string into classified lines. A trailing newline does not
 * emit a spurious empty final line (common in generated diffs).
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff) return []
  const body = diff.endsWith('\n') ? diff.slice(0, -1) : diff
  let inHunk = false
  return body.split('\n').map((line) => {
    const classified = classify(line, inHunk)
    if (classified.kind === 'hunk') inHunk = true
    return classified
  })
}

export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}
