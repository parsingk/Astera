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

/** A paired Runtime that did not answer the last time this app asked it, or null (review minor). */
export function pairedStateLine(r: { offline: boolean | null }, t: T): string | null {
  return r.offline === true ? (t as (k: string) => string)('settings.remote.paired.notAnswering') : null
}

/** What an unpairing did to the controller's scheduled Jobs (remote governance design §8.2 to §8.4): how many it paused,
 *  how many have no maker on record and keep their schedule, then the Jobs whose pause was refused. An older Host answers
 *  without the counts, and gets the line it had. */
export function revokeDoneLine(
  r: { name: string; pausedJobs?: number; unrecordedScheduled?: number; notPaused?: Array<{ jobId: string }> },
  t: T
): string {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  const refused = r.notPaused ?? []
  // A controller that made no scheduled Job is just unpaired, as before (ruling R8-3)
  if (typeof r.pausedJobs !== 'number' || typeof r.unrecordedScheduled !== 'number' || (r.pausedJobs === 0 && r.unrecordedScheduled === 0 && refused.length === 0))
    return tt('settings.remote.revoke.done', { name: r.name })
  const line = tt('settings.remote.revoke.paused', { name: r.name, paused: r.pausedJobs, unrecorded: r.unrecordedScheduled })
  return refused.length === 0 ? line : `${line} ${tt('settings.remote.revoke.notPaused', { jobs: refused.map((j) => j.jobId).join(', ') })}`
}

/** A refusal as a person reads it: its code, then its sentence. */
export function failureLine(r: { ok: false; code: string; message: string }, t: T): string {
  return (t as (k: string, p?: Record<string, string | number>) => string)('settings.remote.failed', { code: r.code, message: r.message })
}

/** An address to listen on, named with where it is: its interface, or this computer only for 127.0.0.1. */
export function addressLabel(c: { address: string; iface: string | null; local: boolean }, t: T): string {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  return c.local ? tt('settings.remote.start.local', { address: c.address }) : tt('settings.remote.start.iface', { address: c.address, iface: c.iface ?? '' })
}

/** How long a pairing string has left, as m:ss, or that it is spent (also for a time that cannot be read). */
export function pairingLeftLine(expiresAt: string, now: number, t: T): string {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  const left = Date.parse(expiresAt) - now
  if (!Number.isFinite(left) || left <= 0) return tt('settings.remote.newPair.expired')
  const s = Math.ceil(left / 1000)
  return tt('settings.remote.newPair.expires', { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` })
}

/** Where a pairing string this screen made stands: `live` while the Host still holds its code (a Host too old to name
 *  its codes is taken at its word until the expiry), `expired` past it, `spent` once used, dropped or burned, and `gone`
 *  with Remote off or the Host unable to say: nothing could redeem it then. */
export function pairingState(made: { expiresAt: string; pairingId?: string }, mine: ThisMachine, now: number): 'live' | 'expired' | 'spent' | 'gone' {
  if (mine === null || (mine.gateway as { state: string }).state === 'disabled') return 'gone'
  const at = Date.parse(made.expiresAt)
  if (!Number.isFinite(at) || at <= now) return 'expired'
  const pending = (mine as { pairings?: unknown }).pairings
  if (made.pairingId !== undefined && Array.isArray(pending) && !pending.includes(made.pairingId)) return 'spent'
  return 'live'
}

/** A refusal of one of This computer's controls, in the app's language where it is a known one (the CLI's sentences
 *  name CLI commands and are English); any other with its code and message, as `failureLine`. */
export function controlFailureLine(r: { ok: false; code: string; message: string }, op: 'start' | 'stop' | 'pair' | 'revoke', t: T): string {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  if (r.code === 'INVALID_ARGUMENTS' && op === 'start') return tt('settings.remote.control.badAddress')
  if (r.code === 'CONFLICT' && op === 'pair') return tt('settings.remote.control.off')
  if (r.code === 'HOST_NOT_RUNNING') return tt('settings.remote.control.noHost')
  if (r.code === 'TIMEOUT' && op === 'start') return tt('settings.remote.control.timeout')
  const gateway = /the Gateway failed: ([A-Z_]+)/.exec(r.message)
  if (r.code === 'FAILED' && op === 'start' && gateway) return tt('settings.remote.control.gatewayFailed', { code: gateway[1] })
  return failureLine(r, t)
}
