// How Settings › Plugins keeps its list fresh (plugin runtime design slice 2d), apart from the component so it is
// tested with a clock: a plugin's status (starting, a crash, failed) has no event yet, so the list is read every few
// seconds while the tab is open.
import type { PluginsCallAnswer } from '../../../core/types'

type Failure = Extract<PluginsCallAnswer, { ok: false }>

/** Reads the list at once and every `everyMs`, one read at a time. A tick is skipped while `busy()`: the Host's plugin
 *  calls run one at a time, so a read sent during a long change (an install of a large folder) would wait behind it
 *  and pass the app's deadline, saying the Host did not answer when it is only busy (2d final review I1). `now()`
 *  reads whatever `busy()` says, as a change does when it ends; asked while a read is in flight, it reads once more
 *  after that one, so its answer is never older than the ask. */
export function createPluginsPoller(d: {
  read: () => Promise<PluginsCallAnswer>
  /** The plugins, and the whole answer (Safe Mode rides on it, Phase 4). */
  onList: (plugins: Record<string, unknown>[], body: Record<string, unknown>) => void
  onFailure: (r: Failure) => void
  busy: () => boolean
  everyMs: number
}): { now(): Promise<void>; start(): () => void } {
  let reading: Promise<void> | null = null
  let again = false
  const readOnce = async (): Promise<void> => {
    const r = await d.read()
    if (!r.ok) return d.onFailure(r)
    const list = Array.isArray(r.body.plugins) ? r.body.plugins : []
    d.onList(
      list.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && !Array.isArray(p)),
      r.body
    )
  }
  const now = (): Promise<void> => {
    if (reading) {
      again = true
      return reading
    }
    reading = (async () => {
      try {
        do {
          again = false
          await readOnce()
        } while (again)
      } finally {
        reading = null
      }
    })()
    return reading
  }
  return {
    now,
    start: () => {
      void now()
      const timer = setInterval(() => {
        if (!d.busy()) void now()
      }, d.everyMs)
      return () => clearInterval(timer)
    }
  }
}

/** `o` without the entries of ids no longer listed; the same object when nothing goes, so a refresh does not re-render
 *  what did not change (2d final review M3). */
export function keepOnly<V>(o: Record<string, V>, ids: ReadonlySet<string>): Record<string, V> {
  const gone = Object.keys(o).filter((k) => !ids.has(k))
  if (gone.length === 0) return o
  const next = { ...o }
  for (const k of gone) delete next[k]
  return next
}

/** Whether an install holds the tab: from the folder or package being read (an npm inspect downloads, and the Host's
 *  plugin calls wait behind it) to the install's end, the list is not polled and the cards wait (2e final review I4). */
export const installHolds = (phase: 'idle' | 'reading' | 'installing'): boolean => phase !== 'idle'

/** Whether the last list said there is nothing to install into: no Host, or one that runs no plugins (M5). */
export const installBlocked = (code: string | null): boolean => code === 'HOST_NOT_RUNNING' || code === 'NOT_SUPPORTED'
