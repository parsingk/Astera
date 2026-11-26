// A finding known across rounds (Phase 3 design §5 Part 1). A review issue gets a new id every round and a check's
// findings are numbered by position, so neither says "the same problem" in the next round. A person's repair request, and
// later the finding's state, follow this instead: a fingerprint of what the finding says, within its Task. Main and the
// Host compute it; the renderer only carries it on a row.
import { createHash } from 'node:crypto'
import { isUnder, relativeTo } from '../context/contextRef'
import { foldPathCase } from '../files/paths'

export type FindingKind = 'check' | 'review' | 'test'

/**
 * The file as the finding named it, written one way: relative to the first of `base` (the Task's folders) that holds it
 * when it was named absolutely, forward slashes, no leading `./`, and a drive letter's path in one case, since Windows
 * does not tell those apart (final review M8: a check that reports absolute paths names the same file as one that
 * reports it relative).
 */
const fileKey = (file: string | undefined, base: readonly string[]): string => {
  const within = file === undefined ? undefined : base.find((b) => isUnder(b, file))
  const named = (within !== undefined && file !== undefined ? relativeTo(within, file) : (file ?? '')).replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  return /^[a-zA-Z]:\//.test(named) ? foldPathCase(named, 'win32') : named
}

/** The message as one line with single spaces, so a reflowed message is the same finding. */
const messageKey = (message: string): string => message.replace(/\s+/g, ' ').trim()

/**
 * `<kind>:<taskId>:<12 hex>`: the first 12 hex of the sha256 of the kind, the producer (`source`: a check's
 * configuration, so two checks saying the same thing of one file stay two findings), the file and the finding's code,
 * or its message when it has no code (a code survives a reworded message: a linter's "line too long (130 > 100)" is
 * still E501). The public form `astera tasks repair --finding` takes. `base` is the Task's folders (taskFoldersOf), to
 * read an absolute file as the relative one it is.
 */
export function findingRef(a: { kind: FindingKind; taskId: string; source?: string; file?: string; base?: readonly string[]; code?: string; message: string }): string {
  const what = a.code !== undefined && a.code !== '' ? `code:${a.code}` : `message:${messageKey(a.message)}`
  const hash = createHash('sha256').update(`${a.kind}\0${a.source ?? ''}\0${fileKey(a.file, a.base ?? [])}\0${what}`).digest('hex').slice(0, 12)
  return `${a.kind}:${a.taskId}:${hash}`
}
