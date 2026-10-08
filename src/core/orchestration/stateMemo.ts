// The last answer for the last state object asked about (audit OR-6). The orchestration state is replaced on every
// commit and never mutated, so the same object means the same answer: a 50 ms probe that finds the state unchanged
// need not walk it again.

export function lastByState<S extends object, T>(f: (s: S) => T): (s: S) => T {
  let last: { s: S; value: T } | null = null
  return (s) => {
    if (last && last.s === s) return last.value
    const value = f(s)
    last = { s, value }
    return value
  }
}
