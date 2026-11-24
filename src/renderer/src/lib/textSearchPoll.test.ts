import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TextSearchAnswer } from '../../../core/files/textMatch'
import { pollTextSearch, type TextSearchState } from './textSearchPoll'

afterEach(() => {
  vi.useRealTimers()
})

const row = (line: number) => ({ path: '/p/a.ts', line, col: 1, preview: 'x', ranges: [[0, 1]] as Array<[number, number]> })

/** An ask that answers from a script, one answer per call, repeating the last one. */
const scripted = (answers: TextSearchAnswer[]) => {
  let n = 0
  return vi.fn(async () => answers[Math.min(n++, answers.length - 1)])
}

describe('pollTextSearch', () => {
  // Spec W2 input debounce: typing a word asks once, for the word, not once per letter.
  it('asks only after the delay, and not at all when stopped before it', async () => {
    vi.useFakeTimers()
    const ask = scripted([{ matches: [], searching: false }])
    const stop = pollTextSearch(ask, () => {}, () => {}, { delayMs: 150, pollMs: 100 })
    await vi.advanceTimersByTimeAsync(149)
    expect(ask).not.toHaveBeenCalled()
    stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ask).not.toHaveBeenCalled()
    const later = scripted([{ matches: [], searching: false }])
    pollTextSearch(later, () => {}, () => {}, { delayMs: 150, pollMs: 100 })
    await vi.advanceTimersByTimeAsync(150)
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('asks again while main is still reading files, rows filling in, and stops when it is done', async () => {
    vi.useFakeTimers()
    const ask = scripted([
      { matches: [], searching: true },
      { matches: [row(1)], searching: true },
      { matches: [row(1), row(2)], searching: false, truncated: true, fileCut: true, partial: true }
    ])
    const states: TextSearchState[] = []
    pollTextSearch(ask, (s) => states.push(s), () => {}, { delayMs: 0, pollMs: 100 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ask).toHaveBeenCalledTimes(3)
    expect(states.map((s) => s.matches.length)).toEqual([0, 1, 2])
    expect(states.at(-1)).toEqual({ matches: [row(1), row(2)], searching: false, unavailable: false, truncated: true, fileCut: true, partial: true })
  })

  it('says when the project could not be listed', async () => {
    vi.useFakeTimers()
    const states: TextSearchState[] = []
    pollTextSearch(scripted([{ matches: [], searching: false, unavailable: true }]), (s) => states.push(s), () => {}, { delayMs: 0, pollMs: 100 })
    await vi.advanceTimersByTimeAsync(500)
    expect(states).toEqual([{ matches: [], searching: false, unavailable: true }])
  })

  it('stops asking after its poll cap, keeping the rows and no longer saying it searches', async () => {
    vi.useFakeTimers()
    const ask = scripted([{ matches: [row(1)], searching: true }])
    const states: TextSearchState[] = []
    pollTextSearch(ask, (s) => states.push(s), () => {}, { delayMs: 0, pollMs: 100, maxPolls: 3 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ask).toHaveBeenCalledTimes(4)
    expect(states.at(-1)).toEqual({ matches: [row(1)], searching: false, unavailable: false })
  })

  it('drops an answer that comes back after it was stopped', async () => {
    vi.useFakeTimers()
    let answer: (a: TextSearchAnswer) => void = () => {}
    const ask = vi.fn(() => new Promise<TextSearchAnswer>((r) => (answer = r)))
    const onState = vi.fn()
    const stop = pollTextSearch(ask, onState, () => {}, { delayMs: 0, pollMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    stop()
    answer({ matches: [row(1)], searching: false })
    await vi.advanceTimersByTimeAsync(500)
    expect(onState).not.toHaveBeenCalled()
  })

  it('ends quietly on a refused ask', async () => {
    vi.useFakeTimers()
    const onFailed = vi.fn()
    pollTextSearch(vi.fn(async () => Promise.reject(new Error('not allowed'))), () => {}, onFailed, { delayMs: 0, pollMs: 100 })
    await vi.advanceTimersByTimeAsync(500)
    expect(onFailed).toHaveBeenCalledTimes(1)
  })
})
