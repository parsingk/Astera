// Joining a Run console's replay with the live output that raced it (second pass R2-7). Each live chunk carries `end`,
// the run's output length after it; the replay carries the length it reached. Live output is held until the replay is
// in, and then only what lies past it is written.

export interface ReplayJoin {
  /** A live chunk, and the run's output length after it (absent from a main that does not count). */
  live(data: string, end?: number): void
  /** The replay and the output length it reaches. */
  replay(text: string, end: number): void
}

export function createReplayJoin(write: (s: string) => void): ReplayJoin {
  let reached: number | null = null
  const held: Array<{ data: string; end?: number }> = []
  const take = (data: string, end?: number): void => {
    if (reached === null) return void held.push({ data, end })
    if (end === undefined) return write(data)
    if (end <= reached) return
    const start = end - data.length
    write(start < reached ? data.slice(reached - start) : data)
    reached = end
  }
  return {
    live: take,
    replay: (text, end) => {
      if (reached !== null) return
      if (text) write(text)
      reached = end
      for (const c of held.splice(0)) take(c.data, c.end)
    }
  }
}
