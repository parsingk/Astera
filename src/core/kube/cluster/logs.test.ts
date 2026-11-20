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
})
