// Two lanes with backpressure for one outgoing stream (remote runtime design §3.1, X1-10). Control lines (replies,
// errors, close frames, pongs) always go before bulk lines (output, pushes), and a bulk line with a key replaces the
// one already waiting under that key, so a slow reader gets the newest projection, not every one. Nothing more is
// handed to the stream once it says it is full (`writableNeedDrain`); writing resumes on 'drain'. What the stream already
// holds counts against the hard cap, so dropping this queue never pretends to free bytes the stream still has.
import type { Writable } from 'node:stream'

export interface LaneWriter {
  control(line: string): void
  bulk(key: string, line: string): void
  /** Bytes waiting here plus bytes the stream has not finished writing. */
  queued(): number
  destroy(): void
}

export function createLaneWriter(out: Writable, o: { hardCap: number; onHardCap(): void }): LaneWriter {
  const control: string[] = []
  const bulk = new Map<string, string>()
  let held = 0
  let waiting = false
  let capped = false
  let dead = false

  const flush = (): void => {
    waiting = false
    while (!dead && !out.writableNeedDrain) {
      let line: string | undefined = control.shift()
      if (line === undefined) {
        const first = bulk.entries().next()
        if (first.done) break
        bulk.delete(first.value[0])
        line = first.value[1]
      }
      held -= Buffer.byteLength(line)
      out.write(line)
    }
    if (!dead && (control.length > 0 || bulk.size > 0) && !waiting) {
      waiting = true
      out.once('drain', flush)
    }
  }

  const check = (): void => {
    if (!capped && held + out.writableLength > o.hardCap) {
      capped = true
      o.onHardCap()
    }
  }

  return {
    control: (line) => {
      if (dead) return
      control.push(line)
      held += Buffer.byteLength(line)
      if (!waiting) flush()
      check()
    },
    bulk: (key, line) => {
      if (dead) return
      const old = bulk.get(key)
      if (old !== undefined) held -= Buffer.byteLength(old)
      bulk.set(key, line)
      held += Buffer.byteLength(line)
      if (!waiting) flush()
      check()
    },
    queued: () => held + out.writableLength,
    destroy: () => {
      dead = true
      control.length = 0
      bulk.clear()
      held = 0
    }
  }
}
