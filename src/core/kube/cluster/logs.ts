/** Pod log lines: numbering, cap, filter, ANSI colours and the Pod facts the logs tab needs. The renderer imports this, so
 *  nothing here may touch `node:`. */
import type { K8sObject } from '../objects'
export type { LogOptions } from './types'

export const LOG_TAIL_LINES = 1000
export const LOG_MAX_LINES = 50_000

/** `n` is a running index over the whole read, so it stays stable when the oldest lines are dropped. `lower`: the
 *  visible text in lower case, worked out once as the line arrives, since the filter reads every line at every frame. */
export interface LogLine { n: number; ts: string | null; text: string; lower: string }
export interface LogBuffer { lines: LogLine[]; dropped: number; next: number }

export function emptyLogBuffer(): LogBuffer {
  return { lines: [], dropped: 0, next: 0 }
}

// kubectl --timestamps: RFC3339 with nanoseconds, then one space.
const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) /

export function splitTimestamp(raw: string): { ts: string | null; text: string } {
  const m = STAMP_RE.exec(raw)
  return m ? { ts: m[1], text: raw.slice(m[0].length) } : { ts: null, text: raw }
}

const STAMP_PARTS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/

/** Orders two kubectl time stamps. kubelet writes nanoseconds without their trailing zeros, so the text of two stamps
 *  does not sort by time: whole seconds compare as dates, then the fractions padded to nine digits. */
export function compareStamps(a: string, b: string): number {
  const pa = STAMP_PARTS.exec(a)
  const pb = STAMP_PARTS.exec(b)
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0
  const seconds = Date.parse(pa[1] + pa[3]) - Date.parse(pb[1] + pb[3])
  if (seconds !== 0) return seconds
  const fa = (pa[2] ?? '').padEnd(9, '0')
  const fb = (pb[2] ?? '').padEnd(9, '0')
  return fa < fb ? -1 : fa > fb ? 1 : 0
}

/** The lines stamped after `since`: kubectl's --since-time counts whole seconds, so a stream read on from a line sends
 *  that second's lines again. A line without a stamp stays. */
export function linesAfter(raw: readonly string[], since: string): string[] {
  return raw.filter((r) => {
    const ts = splitTimestamp(r).ts
    return ts === null || compareStamps(ts, since) > 0
  })
}

export function appendLines(buf: LogBuffer, raw: string[], max: number = LOG_MAX_LINES): LogBuffer {
  let next = buf.next
  const lines = buf.lines.concat(
    raw.map((r) => {
      const { ts, text } = splitTimestamp(r)
      return { n: next++, ts, text, lower: visibleText(text).toLowerCase() }
    })
  )
  const over = Math.max(0, lines.length - max)
  return { lines: over > 0 ? lines.slice(over) : lines, dropped: buf.dropped + over, next }
}

export function filterLines(lines: readonly LogLine[], text: string): LogLine[] {
  if (text === '') return lines.slice()
  const needle = text.toLowerCase()
  return lines.filter((l) => l.lower.includes(needle))
}

/** Local HH:MM:SS.mmm. The fraction is cut to milliseconds by hand: Date parsing of nanoseconds is not specified. */
export function stampText(ts: string): string {
  const d = new Date(ts.replace(/(\.\d{3})\d+/, '$1'))
  if (Number.isNaN(d.getTime())) return ts
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** When a container finished, for the closing line: local HH:MM:SS (finishedAt counts whole seconds), with the local
 *  date before it when that is not `now`'s day. */
export function finishedText(at: string, now: Date): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const p = (n: number): string => String(n).padStart(2, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return today ? time : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`
}

export interface Span { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const token = (i: number): string => `var(--ansi-${i < 8 ? '' : 'bright-'}${NAMES[i % 8]})`

function color256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined
  if (n < 16) return token(n)
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v}, ${v}, ${v})`
  }
  const c = n - 16
  const lvl = (x: number): number => (x === 0 ? 0 : 55 + x * 40)
  return `rgb(${lvl(Math.floor(c / 36))}, ${lvl(Math.floor(c / 6) % 6)}, ${lvl(c % 6)})`
}

type Style = Omit<Span, 'text'>

/** Applies one SGR parameter list to the style. `38`/`48` consume their operands; a malformed one ends the list. */
function applySgr(style: Style, params: number[]): Style {
  let s: Style = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) s = {}
    else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 22) { delete s.bold; delete s.dim }
    else if (p === 23) delete s.italic
    else if (p === 24) delete s.underline
    else if (p >= 30 && p <= 37) s.fg = token(p - 30)
    else if (p >= 90 && p <= 97) s.fg = token(p - 90 + 8)
    else if (p >= 40 && p <= 47) s.bg = token(p - 40)
    else if (p >= 100 && p <= 107) s.bg = token(p - 100 + 8)
    else if (p === 39) delete s.fg
    else if (p === 49) delete s.bg
    else if (p === 38 || p === 48) {
      let c: string | undefined
      if (params[i + 1] === 5) {
        c = color256(params[i + 2])
        i += 2
      } else if (params[i + 1] === 2) {
        const [r, g, b] = params.slice(i + 2, i + 5)
        if ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) c = `rgb(${r}, ${g}, ${b})`
        i += 4
      } else break
      if (c !== undefined) {
        if (p === 38) s.fg = c
        else s.bg = c
      }
    }
  }
  return s
}

// In order: a complete CSI (only one ending in `m` is a style), a CSI cut off at the end of the line, a charset designator
// (`ESC ( B`), a string sequence (OSC, DCS, SOS, PM, APC) up to BEL or ST or the end of the line, any other two-character
// escape, and a lone ESC. Whatever is removed never leaves its payload behind in the visible text.
const ESC_RE = /\u001b(?:\[([0-9;:?]*)[ -/]*([@-~])|\[[0-9;:?]*[ -/]*$|[()*+]\S?|[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\|$)|[@-Z\\-_])?/g

export function ansiSpans(text: string): Span[] {
  if (!text.includes('\u001b')) return text === '' ? [] : [{ text }]
  const spans: Span[] = []
  let style: Style = {}
  let last = 0
  const push = (to: number): void => {
    if (to > last) spans.push({ text: text.slice(last, to), ...style })
  }
  for (const m of text.matchAll(ESC_RE)) {
    push(m.index)
    last = m.index + m[0].length
    if (m[2] === 'm' && !m[1].includes('?')) {
      style = applySgr(style, m[1] === '' ? [0] : m[1].split(/[;:]/).map((x) => (x === '' ? 0 : Number(x))))
    }
  }
  push(text.length)
  return spans
}

export function visibleText(text: string): string {
  if (!text.includes('\u001b')) return text
  return ansiSpans(text).map((s) => s.text).join('')
}

export interface ContainerChoice { name: string; init: boolean }

interface NamedSpec { name?: string }
interface ContainerStatus {
  name?: string
  restartCount?: number
  state?: { waiting?: { reason?: string }; terminated?: { exitCode?: number; finishedAt?: string } }
  lastState?: { terminated?: { exitCode?: number; finishedAt?: string } }
}

const specList = (pod: K8sObject, key: 'containers' | 'initContainers'): string[] => {
  const list = (pod.spec as { [k: string]: unknown } | undefined)?.[key]
  return Array.isArray(list) ? (list as NamedSpec[]).flatMap((c) => (typeof c?.name === 'string' ? [c.name] : [])) : []
}

export function containersOf(pod: K8sObject): ContainerChoice[] {
  return [
    ...specList(pod, 'initContainers').map((name) => ({ name, init: true })),
    ...specList(pod, 'containers').map((name) => ({ name, init: false }))
  ]
}

export function defaultContainer(pod: K8sObject): string | null {
  const names = specList(pod, 'containers')
  const annotated = (pod.metadata.annotations as { [k: string]: string } | undefined)?.['kubectl.kubernetes.io/default-container']
  if (annotated !== undefined && names.includes(annotated)) return annotated
  return names[0] ?? null
}

function statusOf(pod: K8sObject, container: string): ContainerStatus | undefined {
  const st = pod.status as { containerStatuses?: ContainerStatus[]; initContainerStatuses?: ContainerStatus[] } | undefined
  return [...(st?.containerStatuses ?? []), ...(st?.initContainerStatuses ?? [])].find((s) => s.name === container)
}

export function previousByDefault(pod: K8sObject, container: string): boolean {
  return statusOf(pod, container)?.state?.waiting?.reason === 'CrashLoopBackOff'
}

/** How often the container has been started again; 0 before it has a status. */
export function restartCountOf(pod: K8sObject, container: string): number {
  return statusOf(pod, container)?.restartCount ?? 0
}

/** A waiting container has no newer run than its last one, and kubectl gives that run for the current logs too: its
 *  exit is in lastState. `restartsAtStart`: the container's restart count when the followed stream started. kubectl
 *  ends before the kubelet writes the exit, and a container read running again has the followed one's exit in
 *  lastState only when its count grew past this one. */
export function exitLine(
  pod: K8sObject,
  container: string,
  previous: boolean,
  restartsAtStart?: number | null
): { code: number; at: string | null } | null {
  const s = statusOf(pod, container)
  let t = previous || s?.state?.waiting !== undefined ? s?.lastState?.terminated : s?.state?.terminated
  if (t === undefined && !previous && typeof restartsAtStart === 'number' && restartCountOf(pod, container) > restartsAtStart) {
    t = s?.lastState?.terminated
  }
  if (t === undefined || typeof t.exitCode !== 'number') return null
  return { code: t.exitCode, at: t.finishedAt ?? null }
}

export function logFileName(pod: string, container: string, previous: boolean): string {
  return `${pod}_${container}${previous ? '_previous' : ''}.log`.replace(/[^A-Za-z0-9._-]/g, '_')
}
