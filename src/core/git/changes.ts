// A Run's changed files and one file's diff, read from the owning machine's git (remote runtime design Phase 10). The
// Host answers them to controllers and the app answers them for its own Runs, so they live in core. A file is named by
// an id derived from what it is in the range, never by a path a caller sends (§4.8); its `path` is the repo's own,
// relative and with forward slashes, shown as text.
import { createHash } from 'node:crypto'
import { git } from '../worktrees/git'
import type { GitRun } from './range'
import type { ChangedFile } from './changedFile'

export type { ChangedFile } from './changedFile'

/** A diff past this is cut at a line and marked truncated: the reply crosses the link whole. */
export const DIFF_MAX_BYTES = 1024 * 1024
const TIMEOUT_MS = 30_000
const QUOTEPATH_OFF = ['-c', 'core.quotePath=false']
/** The diff a person gets from plain `git diff`, whatever their config adds: no colour, no external diff tool, no text
 *  conversion filters. */
const PLAIN = ['--no-color', '--no-ext-diff', '--no-textconv']

const defaultRun: GitRun = (args, opts) => git(args, opts)

export function fileIdOf(f: { status: string; path: string; oldPath?: string }): string {
  return createHash('sha256').update(`${f.status}\0${f.oldPath ?? ''}\0${f.path}`).digest('base64url').slice(0, 16)
}

const range = (base: string, head: string | null): string[] => (head === null ? [base] : [base, head])

const statusOf = (letter: string): ChangedFile['status'] =>
  letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'R' ? 'renamed' : 'modified'

/** `--name-status -z`: a status field, then one path, or two for a rename or copy. */
function parseNameStatus(out: string): Array<{ status: ChangedFile['status']; path: string; oldPath?: string }> {
  const parts = out.split('\0')
  const files: Array<{ status: ChangedFile['status']; path: string; oldPath?: string }> = []
  for (let i = 0; i < parts.length; ) {
    const field = parts[i++]
    if (!field) continue
    const letter = field[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i++]
      const path = parts[i++]
      // A copy leaves its source in place: what changed is a new file.
      files.push(letter === 'R' ? { status: 'renamed', path, oldPath } : { status: 'added', path })
    } else files.push({ status: statusOf(letter), path: parts[i++] })
  }
  return files
}

/** `--numstat -z`: `added\tdeleted\tpath\0`, or for a rename `added\tdeleted\t\0old\0new\0`; `-` for binary. */
function parseNumstat(out: string): Map<string, { additions?: number; deletions?: number; binary?: true }> {
  const parts = out.split('\0')
  const counts = new Map<string, { additions?: number; deletions?: number; binary?: true }>()
  for (let i = 0; i < parts.length; ) {
    const field = parts[i++]
    if (!field) continue
    const [a, d, inline] = field.split('\t')
    const path = inline === '' || inline === undefined ? (i++, parts[i++]) : inline
    counts.set(path, a === '-' ? { binary: true } : { additions: Number(a), deletions: Number(d) })
  }
  return counts
}

/** The files that differ between `base` and `head`, or the working tree when `head` is null (tracked files only).
 *  Null when git cannot answer (an unknown commit, a folder that is not a repo). */
export async function readChanges(repo: string, base: string, head: string | null, run: GitRun = defaultRun): Promise<ChangedFile[] | null> {
  const opts = { cwd: repo, timeoutMs: TIMEOUT_MS, trim: false }
  const [names, nums] = await Promise.all([
    run([...QUOTEPATH_OFF, 'diff', ...PLAIN, '--name-status', '-z', '-M', ...range(base, head), '--'], opts),
    run([...QUOTEPATH_OFF, 'diff', ...PLAIN, '--numstat', '-z', '-M', ...range(base, head), '--'], opts)
  ])
  if (!names.ok || !nums.ok) return null
  const counts = parseNumstat(nums.stdout)
  return parseNameStatus(names.stdout).map((f) => {
    const c = counts.get(f.path) ?? {}
    const file: ChangedFile = { id: fileIdOf(f), path: f.path, ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}), status: f.status }
    if (c.binary) file.binary = true
    else {
      if (c.additions !== undefined) file.additions = c.additions
      if (c.deletions !== undefined) file.deletions = c.deletions
    }
    return file
  })
}

/** One file's diff over the same range, as `git diff` prints it; cut at a line past `maxBytes`. */
export async function readFileDiff(
  repo: string,
  base: string,
  head: string | null,
  f: ChangedFile,
  o: { maxBytes?: number; run?: GitRun } = {}
): Promise<{ diff: string; truncated: boolean } | null> {
  const maxBytes = o.maxBytes ?? DIFF_MAX_BYTES
  const paths = f.oldPath !== undefined ? [f.oldPath, f.path] : [f.path]
  const r = await (o.run ?? defaultRun)([...QUOTEPATH_OFF, 'diff', ...PLAIN, '-M', ...range(base, head), '--', ...paths], {
    cwd: repo,
    timeoutMs: TIMEOUT_MS,
    trim: false
  })
  if (!r.ok) return null
  if (Buffer.byteLength(r.stdout) <= maxBytes) return { diff: r.stdout, truncated: false }
  const cut = Buffer.from(r.stdout).subarray(0, maxBytes).toString('utf8')
  // At the last whole line; a character split by the byte cut is dropped with it.
  const at = cut.lastIndexOf('\n')
  return { diff: at < 0 ? '' : cut.slice(0, at + 1), truncated: true }
}
