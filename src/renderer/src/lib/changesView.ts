// What the changed files block shows for a `runs-changed-files` reply (remote runtime design Phase 10): the list, a
// Runtime that does not offer it (one from before this phase, said by the app's client before anything is sent), or
// the refusal in its own words.
import type { ChangedFilesReply } from '../../../core/git/changedFile'

export type ChangesView = { kind: 'ok'; reply: ChangedFilesReply } | { kind: 'unsupported' } | { kind: 'failed'; message: string }

export function changesView(r: { status: number; body: unknown }): ChangesView {
  const b = r.body as { code?: unknown; error?: unknown } | null
  if (r.status === 200) return { kind: 'ok', reply: r.body as ChangedFilesReply }
  if (b?.code === 'RUNTIME_CAPABILITY_MISSING') return { kind: 'unsupported' }
  return { kind: 'failed', message: String(b?.error ?? r.status) }
}
