// The sentences Settings › Remote Runtimes shows (remote runtime design Phase 6), apart from the component so each
// is tested as text.
import type { RemoteApi } from '../../../core/types'

type T = (key: never, params?: Record<string, string | number>) => string
type ThisMachine = Awaited<ReturnType<RemoteApi['thisMachine']>>
type Ping = Awaited<ReturnType<RemoteApi['ping']>>

/** This computer as a Runtime: unknown when its Host cannot say, off, or on with where it listens. */
export function thisMachineLine(s: ThisMachine, t: T): string {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  if (s === null) return tt('settings.remote.thisMachine.unknown')
  const g = s.gateway as { state: string; listen?: string; port?: number }
  if (g.state === 'disabled') return tt('settings.remote.thisMachine.off')
  return tt('settings.remote.thisMachine.on', { listen: g.listen ?? '?', port: g.port ?? '?', state: g.state })
}

/** What a ping found: who answered, or the code it failed with. */
export function pingLine(p: Ping, t: T): string {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  if (!p.ok) return tt('settings.remote.paired.offline', { code: p.code })
  return tt('settings.remote.paired.online', { version: p.hello?.asteraVersion ?? '?', platform: p.hello?.platform ?? '?' })
}

/** A refusal as a person reads it: its code, then its sentence. */
export function failureLine(r: { ok: false; code: string; message: string }, t: T): string {
  return (t as (k: string, p?: Record<string, string | number>) => string)('settings.remote.failed', { code: r.code, message: r.message })
}
