/** Port forwarding: which objects offer it, their ports, the kubectl arguments and how to read kubectl's lines. The
 *  renderer imports this, so nothing here may touch `node:`. */
import type { K8sObject } from '../objects'
import type { ForwardPort, ForwardSpec, LostCause } from './types'

/** Loopback only: a forward is never reachable from the network. */
export const FORWARD_ADDRESS = '127.0.0.1'
/** The reason of a forward that ended because its Pod was replaced. */
export const LOST_POD = 'lost-pod'
/** The reason of a forward whose Pod refused the connection (nothing listens on the remote port). */
export const REFUSED = 'refused'
/** The reason of a forward that lost its connection for a cause kubectl's lines do not tell. */
export const LOST = 'lost'

export function validPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535
}

export function canForward(kind: string, o: K8sObject | null): boolean {
  if (kind === 'Service' || kind === 'Deployment') return true
  if (kind === 'Pod') return (o?.status as { phase?: string } | undefined)?.phase === 'Running'
  return false
}

interface PortEntry { port?: unknown; containerPort?: unknown; name?: unknown; protocol?: unknown }

interface PodSpecLike { containers?: { ports?: PortEntry[] }[] }

function containerEntries(spec: PodSpecLike | undefined): PortEntry[] {
  const list = Array.isArray(spec?.containers) ? spec.containers : []
  return list.flatMap((c) => (Array.isArray(c?.ports) ? c.ports : []))
}

/** TCP ports in spec order, one entry per number: the first name wins. */
export function forwardPorts(o: K8sObject): ForwardPort[] {
  const spec = o.spec as (PodSpecLike & { ports?: PortEntry[]; template?: { spec?: PodSpecLike } }) | undefined
  let entries: PortEntry[]
  if (o.kind === 'Service') entries = Array.isArray(spec?.ports) ? spec.ports : []
  else if (o.kind === 'Deployment') entries = containerEntries(spec?.template?.spec)
  else entries = containerEntries(spec)
  const out: ForwardPort[] = []
  for (const e of entries) {
    if (!e || (e.protocol !== undefined && e.protocol !== 'TCP')) continue
    const port = o.kind === 'Service' ? e.port : e.containerPort
    if (!validPort(port) || out.some((p) => p.port === port)) continue
    out.push(typeof e.name === 'string' && e.name !== '' ? { port, name: e.name } : { port })
  }
  return out
}

export function forwardArgs(spec: ForwardSpec): string[] {
  const { ref, local, remote } = spec
  return [
    'port-forward', '--address', FORWARD_ADDRESS, `${ref.kind.toLowerCase()}/${ref.name}`, `${local}:${remote}`,
    '-n', ref.namespace ?? '', '--context', ref.context
  ]
}

/** The local port of kubectl's ready line, else null. */
export function listeningPort(line: string): number | null {
  const m = /^Forwarding from 127\.0\.0\.1:(\d+) -> \d+/.exec(line.trim())
  return m ? Number(m[1]) : null
}

/** kubectl ends with `error: lost connection to pod` for several causes; only the klog line before it tells them apart.
 *  The last matching line wins. */
export function lostCause(stderr: string): LostCause | null {
  let cause: LostCause | null = null
  for (const line of stderr.split('\n')) {
    if (line.includes('network namespace for sandbox') && line.includes('is closed')) cause = 'pod-gone'
    else if (line.includes('connect: connection refused')) cause = 'refused'
  }
  return cause
}

export function forwardReason(
  message: string | null,
  cause?: LostCause
): typeof LOST_POD | typeof REFUSED | typeof LOST | string | null {
  if (message === null) return null
  if (cause === 'pod-gone') return LOST_POD
  if (cause === 'refused') return REFUSED
  return message.includes('lost connection to pod') ? LOST : message
}

/** What Open uses for a forward: https for port 443 or a port named https, else http. */
export function forwardUrl(spec: ForwardSpec): string {
  const scheme = spec.remote === 443 || spec.remoteName === 'https' ? 'https' : 'http'
  return `${scheme}://${FORWARD_ADDRESS}:${spec.local}/`
}
