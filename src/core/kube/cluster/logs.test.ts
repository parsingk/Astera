import { describe, expect, it } from 'vitest'
import { ansiSpans, appendLines, containersOf, defaultContainer, emptyLogBuffer, exitLine, filterLines, logFileName, previousByDefault, splitTimestamp, visibleText } from './logs'

describe('log logic', () => {
  it('splits the kubectl time stamp', () => {
    expect(splitTimestamp('2026-11-20T01:12:03.114539874Z worker starting')).toEqual({ ts: '2026-11-20T01:12:03.114539874Z', text: 'worker starting' })
    expect(splitTimestamp('no stamp here')).toEqual({ ts: null, text: 'no stamp here' })
  })
  it('drops the oldest beyond the cap and counts them', () => {
    let b = emptyLogBuffer()
    b = appendLines(b, ['a', 'b', 'c'], 2)
    expect(b.lines.map((l) => l.text)).toEqual(['b', 'c'])
    expect(b.dropped).toBe(1)
    expect(appendLines(b, ['d'], 2).lines.map((l) => l.n)).toEqual([2, 3])
  })
  it('filters by visible text', () => {
    const lines = appendLines(emptyLogBuffer(), ['\u001b[31mERROR\u001b[0m could not connect', 'INFO ok']).lines
    expect(filterLines(lines, 'error').map((l) => l.n)).toEqual([0])
    expect(filterLines(lines, '31m')).toEqual([])
  })
  it('parses SGR colours', () => {
    expect(ansiSpans('\u001b[1;31mERR\u001b[0m x')).toEqual([{ text: 'ERR', fg: 'var(--ansi-red)', bold: true }, { text: ' x' }])
    expect(ansiSpans('\u001b[38;2;10;20;30mT\u001b[39m')).toEqual([{ text: 'T', fg: 'rgb(10, 20, 30)' }])
    expect(visibleText('\u001b[2K\u001b[32mok\u001b[0m')).toBe('ok')
  })
  it('picks containers and the default', () => {
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p', annotations: { 'kubectl.kubernetes.io/default-container': 'app' } }, spec: { initContainers: [{ name: 'init' }], containers: [{ name: 'side' }, { name: 'app' }] } }
    expect(containersOf(pod)).toEqual([{ name: 'init', init: true }, { name: 'side', init: false }, { name: 'app', init: false }])
    expect(defaultContainer(pod)).toBe('app')
  })
  it('turns previous on for a crash loop and reads the exit line', () => {
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' }, status: { containerStatuses: [{ name: 'worker', state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 1, finishedAt: '2026-11-20T01:12:11Z' } } }] } }
    expect(previousByDefault(pod, 'worker')).toBe(true)
    expect(exitLine(pod, 'worker', true)).toEqual({ code: 1, at: '2026-11-20T01:12:11Z' })
    expect(exitLine(pod, 'worker', false)).toBeNull()
  })
  it('names the saved file', () => {
    expect(logFileName('worker-6b8f9c-x2kq7', 'worker', true)).toBe('worker-6b8f9c-x2kq7_worker_previous.log')
  })
  it('keeps init containers apart and reads their exit line', () => {
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' }, spec: { initContainers: [{ name: 'init' }], containers: [{ name: 'app' }] }, status: { initContainerStatuses: [{ name: 'init', state: { terminated: { exitCode: 0, finishedAt: '2026-11-20T01:00:00Z' } } }] } }
    expect(containersOf(pod).map((c) => c.init)).toEqual([true, false])
    expect(exitLine(pod, 'init', false)).toEqual({ code: 0, at: '2026-11-20T01:00:00Z' })
    expect(exitLine(pod, 'app', false)).toBeNull()
  })
  it('reads 256 colours, and ESC[m as a reset', () => {
    expect(ansiSpans('\u001b[38;5;196mR\u001b[mx')).toEqual([{ text: 'R', fg: 'rgb(255, 0, 0)' }, { text: 'x' }])
  })
  it('turns bold, dim, italic and underline off with 22, 23 and 24', () => {
    expect(ansiSpans('\u001b[1;2;3;4ma\u001b[22mb\u001b[23mc\u001b[24md')).toEqual([
      { text: 'a', bold: true, dim: true, italic: true, underline: true },
      { text: 'b', italic: true, underline: true },
      { text: 'c', underline: true },
      { text: 'd' }
    ])
  })
  it('keeps the text of an OSC 8 link', () => {
    expect(visibleText('\u001b]8;;https://x.test\u001b\\link\u001b]8;;\u001b\\ and \u001b]8;;u\u0007bel\u001b]8;;\u0007')).toBe('link and bel')
  })
  it('removes unterminated and partial escapes at the end of a line', () => {
    expect(visibleText('ok\u001b[31')).toBe('ok')
    expect(visibleText('ok\u001b')).toBe('ok')
    expect(visibleText('ok\u001b]8;;http://x')).toBe('ok')
    expect(visibleText('ok\u001b[')).toBe('ok')
  })
  it('removes charset designators and DCS, APC and PM strings', () => {
    expect(visibleText('\u001b(Bplain\u001b)0 x')).toBe('plain x')
    expect(visibleText('a\u001bPq1\u001b\\b\u001b_app\u001b\\c\u001b^pm\u001b\\d\u001bPtail')).toBe('abcd')
  })
  it('returns plain text unchanged', () => {
    expect(visibleText('plain')).toBe('plain')
    expect(ansiSpans('plain')).toEqual([{ text: 'plain' }])
    expect(ansiSpans('')).toEqual([])
  })
})
