/** Pod log lines: numbering, cap, filter, ANSI colours and the Pod facts the logs tab needs. The renderer imports this, so
 *  nothing here may touch `node:`. */
import type { K8sObject } from '../objects'
export type { LogOptions } from './types'

export const LOG_TAIL_LINES = 1000
export const LOG_MAX_LINES = 50_000

/** `n` is a running index over the whole read, so it stays stable when the oldest lines are dropped. */
export interface LogLine { n: number; ts: string | null; text: string }
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

export function appendLines(buf: LogBuffer, raw: string[], max: number = LOG_MAX_LINES): LogBuffer {
  let next = buf.next
  const lines = buf.lines.concat(raw.map((r) => ({ n: next++, ...splitTimestamp(r) })))
  const over = Math.max(0, lines.length - max)
  return { lines: over > 0 ? lines.slice(over) : lines, dropped: buf.dropped + over, next }
}

export function filterLines(lines: readonly LogLine[], text: string): LogLine[] {
  if (text === '') return lines.slice()
  const needle = text.toLowerCase()
  return lines.filter((l) => visibleText(l.text).toLowerCase().includes(needle))
}

/** Local HH:MM:SS.mmm. The fraction is cut to milliseconds by hand: Date parsing of nanoseconds is not specified. */
export function stampText(ts: string): string {
  const d = new Date(ts.replace(/(\.\d{3})\d+/, '$1'))
  if (Number.isNaN(d.getTime())) return ts
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
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

export function exitLine(pod: K8sObject, container: string, previous: boolean): { code: number; at: string | null } | null {
  const s = statusOf(pod, container)
  const t = previous ? s?.lastState?.terminated : s?.state?.terminated
  if (t === undefined || typeof t.exitCode !== 'number') return null
  return { code: t.exitCode, at: t.finishedAt ?? null }
}

export function logFileName(pod: string, container: string, previous: boolean): string {
  return `${pod}_${container}${previous ? '_previous' : ''}.log`.replace(/[^A-Za-z0-9._-]/g, '_')
}
