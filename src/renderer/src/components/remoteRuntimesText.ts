// The sentences Settings › Remote Runtimes shows (remote runtime design Phase 6), apart from the component so each
// is tested as text.
import type { RemoteApi, RuntimeDetail } from '../../../core/types'
import type { ComparisonRow, ComparisonState } from '../../../core/controlPlane/compare'
import { localTime } from './findingsText'

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

/** Link failures the person can act on, each with its own sentence (ruling R17-1): the other side answered, so none of
 *  them is "does not answer". */
const LINK_KEYS: Record<string, string> = {
  RUNTIME_AUTH_FAILED: 'settings.remote.link.authFailed',
  RUNTIME_IDENTITY_CHANGED: 'settings.remote.link.identityChanged',
  RUNTIME_PROTOCOL_MISMATCH: 'settings.remote.link.protocolMismatch'
}

/** A link failure's sentence, or null for a code that is not one of them. */
export function linkLine(code: string, t: T): string | null {
  return Object.hasOwn(LINK_KEYS, code) ? (t as (k: string) => string)(LINK_KEYS[code]) : null
}

/** What a ping found: who answered, a link failure in plain words, or the code it failed with. */
export function pingLine(p: Ping, t: T): string {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  if (!p.ok) return linkLine(p.code, t) ?? tt('settings.remote.paired.offline', { code: p.code })
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

/** Both Astera versions, and to update there when the Runtime's is older (remote governance design §4.3); null before
 *  its first hello. A newer Runtime is shown, not flagged. */
export function versionLine(d: { facts: { asteraVersion: string } | null; here: string; older: boolean }, t: T): string | null {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  if (d.facts === null) return null
  const both = tt('settings.remote.detail.versions', { there: d.facts.asteraVersion, here: d.here })
  return d.older ? `${both} ${tt('settings.remote.detail.updateThere')}` : both
}

// A record rather than a list, so tsc flags a state added to compare.ts and not here.
const STATE_KEYS: Record<ComparisonState, string> = {
  missing: 'settings.remote.detail.state.missing',
  different: 'settings.remote.detail.state.different',
  off: 'settings.remote.detail.state.off',
  'secret-missing': 'settings.remote.detail.state.secretMissing',
  same: 'settings.remote.detail.state.same'
}

/** A comparison row's state (§6.2): judged for an expected row, "only there" for an entry only there, else nothing. */
export function stateWord(row: ComparisonRow, t: T): string {
  const tt = t as (k: string) => string
  if (row.state !== null) return tt(STATE_KEYS[row.state])
  return row.here === null ? tt('settings.remote.detail.state.onlyThere') : ''
}

const SURFACE_KEYS: Record<'desktop' | 'cli' | 'mcp', string> = {
  desktop: 'settings.remote.surface.desktop',
  cli: 'settings.remote.surface.cli',
  mcp: 'settings.remote.surface.mcp'
}

/** A paired controller as This computer lists it (§7.3): what it said it is, its Astera and when it was last seen. One
 *  that has not said (an older Host, or a controller from before this release) gets when it was last seen alone, with
 *  nothing guessed. A surface this build does not know is shown as its word (ruling R2-1). */
export function clientSeenLine(c: { surface?: string; clientVersion?: string; lastSeenAt: string | null }, t: T): string {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  if (c.lastSeenAt === null) return tt('settings.remote.paired.neverSeen')
  const at = localTime(c.lastSeenAt)
  if (c.surface === undefined || c.clientVersion === undefined) return tt('settings.remote.paired.lastSeen', { at })
  const surface = Object.hasOwn(SURFACE_KEYS, c.surface) ? tt(SURFACE_KEYS[c.surface as keyof typeof SURFACE_KEYS]) : c.surface
  return tt('settings.remote.thisMachine.clientSeen', { surface, version: c.clientVersion, at })
}

/** A refused edit of the expected list (§6.1). INVALID_ARGUMENTS is an id this computer no longer has, a one-checkbox
 *  edit's only way to get it: said in the app's language, as the CLI's sentence names `astera ext list` (ruling R16-1). */
export function expectFailureLine(r: { ok: false; code: string; message: string }, t: T): string {
  if (r.code === 'INVALID_ARGUMENTS') return (t as (k: string) => string)('settings.remote.detail.expectGone')
  return failureLine(r, t)
}

/** The codes a read gets when the Runtime gave no answer at all: the link failed, or the answer did not come in time. */
const NO_ANSWER = new Set(['RUNTIME_OFFLINE', 'RUNTIME_OUTCOME_UNKNOWN', 'REMOTE_TIMEOUT'])
const CANNOT_REPORT = 'RUNTIME_CAPABILITY_MISSING'
type ReadState = Pick<RuntimeDetail, 'answering' | 'refusal' | 'snapshot'>

/** The link failed for a reason with its own sentence (ruling R17-1), on either path: a read that asked, or a refusal
 *  remembered a moment ago. */
const linkFailed = (d: ReadState): boolean => d.refusal !== undefined && d.answering !== true && Object.hasOwn(LINK_KEYS, d.refusal.code)

/** Whether the detail's refusal says the Runtime does not answer. A read that asked says so in `answering`; one answered
 *  from the refusal remembered a moment ago did not ask (`answering` null), so its code says it (ruling R16-1). */
const notAnswering = (d: ReadState): boolean =>
  d.refusal !== undefined &&
  d.refusal.code !== CANNOT_REPORT &&
  !linkFailed(d) &&
  (d.answering === false || (d.answering === null && NO_ANSWER.has(d.refusal.code)))

/** The detail's health line about now (§10.1): it answers, a link failure in plain words, the existing "does not answer"
 *  line with the code, or nothing when this read did not ask and nothing says it failed (the kept report was recent). */
export function answerLine(d: ReadState, t: T): string | null {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  if (d.answering === true) return tt('settings.remote.detail.answers')
  if (linkFailed(d)) return linkLine(d.refusal?.code ?? '', t)
  return notAnswering(d) ? tt('settings.remote.paired.offline', { code: d.refusal?.code ?? '' }) : null
}

/** How fresh the detail is (§5.4): why no fresh report came, when the health line has not said it (an older Runtime is
 *  told to update there, never shown a bare refusal, §5.1), then when the shown report was read, or that none was yet. */
export function freshnessLines(d: ReadState, t: T): string[] {
  const tt = t as (k: string, p?: Record<string, string | number>) => string
  const why =
    d.refusal === undefined || notAnswering(d) || linkFailed(d)
      ? []
      : d.refusal.code === CANNOT_REPORT
        ? [tt('settings.remote.detail.unsupported')]
        : [failureLine({ ok: false, ...d.refusal }, t)]
  return [...why, d.snapshot ? tt('settings.remote.detail.readAt', { at: localTime(d.snapshot.readAt) }) : tt('settings.remote.detail.notReadYet')]
}
