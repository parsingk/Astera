/** Pod statuses, attention flags and ages as kubectl prints them. Imported by the renderer: no `node:` here. */
import type { K8sObject } from '../objects'
import type { Tone } from './types'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : [])
const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback)

const BAD_WAITING = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError'])
const PHASE_TONE: Record<string, Tone> = { Running: 'ok', Succeeded: 'done', Pending: 'wait', Failed: 'bad', Unknown: 'bad' }

export function podStatus(o: K8sObject): { text: string; tone: Tone } {
  const status = rec(o.status)
  if (o.metadata.deletionTimestamp) return { text: 'Terminating', tone: 'wait' }

  const inits = list(status.initContainerStatuses)
  for (const c of inits) {
    const reason = rec(rec(c.state).waiting).reason
    // PodInitializing only says the init containers are still running, which the progress text below shows.
    if (typeof reason === 'string' && reason && reason !== 'PodInitializing') return { text: `Init:${reason}`, tone: 'bad' }
  }
  const initDone = inits.filter((c) => {
    const t = rec(rec(c.state).terminated)
    return Object.keys(t).length > 0 && t.exitCode === 0
  }).length
  if (initDone < inits.length) return { text: `Init:${initDone}/${inits.length}`, tone: 'wait' }

  const containers = list(status.containerStatuses)
  for (const c of containers) {
    const reason = rec(rec(c.state).waiting).reason
    if (typeof reason === 'string' && reason) return { text: reason, tone: BAD_WAITING.has(reason) ? 'bad' : 'wait' }
  }
  if (containers.length > 0 && containers.every((c) => Object.keys(rec(rec(c.state).terminated)).length > 0)) {
    const reason = rec(rec(containers[containers.length - 1].state).terminated).reason
    if (typeof reason === 'string' && reason) return { text: reason, tone: reason === 'Completed' ? 'done' : 'bad' }
  }

  if (typeof status.reason === 'string' && status.reason) return { text: status.reason, tone: 'bad' }
  const phase = typeof status.phase === 'string' && status.phase ? status.phase : 'Unknown'
  return { text: phase, tone: PHASE_TONE[phase] ?? 'wait' }
}

function conditionIs(o: K8sObject, type: string, value: string): boolean {
  return list(rec(o.status).conditions).some((c) => c.type === type && c.status === value)
}

/** The kinds `needsAttention` has a rule for: only their objects are read to count them (the rest by name). */
export const ATTENTION_KINDS: ReadonlySet<string> = new Set(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'PersistentVolumeClaim', 'Node'])

export function needsAttention(kind: string, o: K8sObject): boolean {
  const status = rec(o.status)
  const spec = rec(o.spec)
  switch (kind) {
    case 'Pod': {
      const phase = status.phase
      if (phase !== 'Running' && phase !== 'Succeeded') return true
      return phase === 'Running' && list(status.containerStatuses).some((c) => c.ready === false)
    }
    case 'Deployment':
    case 'StatefulSet':
      return num(status.readyReplicas, 0) < num(spec.replicas, 1)
    case 'DaemonSet':
      return num(status.numberReady, 0) < num(status.desiredNumberScheduled, 0)
    case 'Job':
      return conditionIs(o, 'Failed', 'True')
    case 'PersistentVolumeClaim':
      return status.phase !== 'Bound'
    case 'Node':
      return !conditionIs(o, 'Ready', 'True')
    default:
      return false
  }
}

/** kubectl's HumanDuration, so a row reads the same here as in a terminal. */
export function ageText(fromIso: string | undefined, nowMs: number): string {
  if (!fromIso) return ''
  const from = Date.parse(fromIso)
  if (Number.isNaN(from)) return ''
  const s = Math.max(0, Math.floor((nowMs - from) / 1000))
  if (s < 120) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 10) return s % 60 === 0 ? `${m}m` : `${m}m${s % 60}s`
  if (m < 180) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 8) return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`
  if (h < 48) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 8) return h % 24 === 0 ? `${d}d` : `${d}d${h % 24}h`
  if (d < 730) return `${d}d`
  const y = Math.floor(d / 365)
  if (y < 8) return `${y}y${d % 365}d`
  return `${y}y`
}
