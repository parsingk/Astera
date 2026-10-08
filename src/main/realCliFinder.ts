// The real CLI on PATH, looked up without a synchronous read per candidate on main's thread (performance audit M8).
//
// The finder (findRealHiggsfield) reads candidates through the `read` it is given, in order, and stops at the first
// one there. It is run once with a read that answers nothing, which makes it name every candidate it would read; those
// are read asynchronously, all at once; then it is run again over what was read. Its rules stay in one place, and a
// folder on PATH that does not answer delays this promise rather than freezing the app. One answer serves every call
// for `ttlMs`, so a list that asks once per account looks once.

export const REAL_CLI_TTL_MS = 5_000

export function createRealCliFinder(a: {
  find(read: (p: string) => string | null): string | null
  readAsync(p: string): Promise<string | null>
  now?: () => number
  ttlMs?: number
}): { find(): Promise<string | null> } {
  const now = a.now ?? Date.now
  const ttlMs = a.ttlMs ?? REAL_CLI_TTL_MS
  let held: { at: number; answer: Promise<string | null> } | null = null
  const look = async (): Promise<string | null> => {
    const named: string[] = []
    a.find((p) => {
      named.push(p)
      return null
    })
    const texts = await Promise.all(named.map((p) => a.readAsync(p).catch(() => null)))
    const read = new Map(named.map((p, i) => [p, texts[i]]))
    return a.find((p) => read.get(p) ?? null)
  }
  return {
    find: () => {
      if (held === null || now() - held.at > ttlMs) held = { at: now(), answer: look() }
      return held.answer
    }
  }
}
