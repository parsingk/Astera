// A finding known across rounds (Phase 3 design §5 Part 1). A review issue gets a new id every round and a check's
// findings are numbered by position, so neither says "the same problem" in the next round. A person's repair request, and
// later the finding's state, follow this instead: a fingerprint of what the finding says, within its Task. Main and the
// Host compute it; the renderer only carries it on a row.
import { createHash } from 'node:crypto'

export type FindingKind = 'check' | 'review' | 'test'

/** The file as the finding named it, written one way: forward slashes, no leading `./`. */
const fileKey = (file: string | undefined): string => (file ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '')

/** The message as one line with single spaces, so a reflowed message is the same finding. */
const messageKey = (message: string): string => message.replace(/\s+/g, ' ').trim()

/**
 * `<kind>:<taskId>:<12 hex>`: the first 12 hex of the sha256 of the kind, the producer (`source`: a check's
 * configuration, so two checks saying the same thing of one file stay two findings), the file and the finding's code,
 * or its message when it has no code (a code survives a reworded message: a linter's "line too long (130 > 100)" is
 * still E501). The public form `astera tasks repair --finding` takes.
 */
export function findingRef(a: { kind: FindingKind; taskId: string; source?: string; file?: string; code?: string; message: string }): string {
  const what = a.code !== undefined && a.code !== '' ? `code:${a.code}` : `message:${messageKey(a.message)}`
  const hash = createHash('sha256').update(`${a.kind}\0${a.source ?? ''}\0${fileKey(a.file)}\0${what}`).digest('hex').slice(0, 12)
  return `${a.kind}:${a.taskId}:${hash}`
}
