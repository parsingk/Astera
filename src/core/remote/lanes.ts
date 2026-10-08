// Two lanes with backpressure for one outgoing stream (remote runtime design §3.1, X1-10). Control lines (replies,
// errors, close frames, pongs) always go before bulk lines (output, pushes), and a bulk line with a key replaces the
// one already waiting under that key, so a slow reader gets the newest projection, not every one. Nothing more is
// handed to the stream once it says it is full (`writableNeedDrain`); writing resumes on 'drain'. What the stream already
// holds counts against the hard cap, so dropping this queue never pretends to free bytes the stream still has.
import type { Writable } from 'node:stream'

export interface LaneWriter {
  control(line: string): void
  bulk(key: string, line: string): void
  /** A stream's next line (pty output, §3.7): kept in order per key, written after control and bulk. `seq` is what
   *  the line carries, so an overflow can say which seqs it lost. `admit`: kept even when it alone is over the stream's
   *  share (a checkpoint, Phase 8 review I3); what follows it is held to the share as usual. */
  stream(key: string, line: string, seq: number, o?: { admit?: boolean }): void
  /** One reply too large for a single line, in its pieces (security audit SEC-1): kept in order on a lane of its own,
   *  outside the hard cap, under `replyCap`. False when it would pass that budget: nothing of it is queued, and the
   *  caller answers with a refusal instead. */
  reply(lines: string[]): boolean
  /** Bytes of replies waiting here. */
  replyQueued(): number
  /** Forgets what a stream has waiting (an unsubscribe). */
  dropStream(key: string): void
  /** Bytes waiting here plus bytes the stream has not finished writing, replies aside. */
  queued(): number
  destroy(): void
}

export function createLaneWriter(
  out: Writable,
  o: {
    hardCap: number
    onHardCap(): void
    /** What one stream may hold waiting (§3.1: 4 MiB a pty on the Host link, the connection's queue at the Gateway). */
    streamPerKey?: number
    /** What every stream together may hold waiting. */
    streamTotal?: number
    /** A stream was dropped past its share or the total: the seqs it lost. The owner ends that stream with OUTPUT_GAP. */
    onStreamOverflow?(key: string, lost: { firstSeq: number; lastSeq: number }): void
    /** What replies together may hold waiting; unbounded when left out. */
    replyCap?: number
  }
): LaneWriter {
  const control: string[] = []
  const bulk = new Map<string, string>()
  /** Each stream's waiting lines, in order. A Map keeps insertion order, which the flush takes in turn. */
  const streams = new Map<string, { lines: Array<{ line: string; seq: number; bytes: number }>; bytes: number }>()
  const perKey = o.streamPerKey ?? Number.POSITIVE_INFINITY
  const total = o.streamTotal ?? Number.POSITIVE_INFINITY
  let streamHeld = 0
  let held = 0
  /** Reply lines waiting, in order, and their bytes. */
  const replies: string[] = []
  let replyHeld = 0
  /** Reply bytes written less stream bytes written, after control and bulk: a reply line goes when it is not ahead, so
   *  turns are by bytes and a stream is not starved by 700 KB reply lines (final review M-1). */
  let balance = 0
  let waiting = false
  let capped = false
  let dead = false

  const flush = (): void => {
    waiting = false
    while (!dead && !out.writableNeedDrain) {
      let line: string | undefined = control.shift()
      if (line === undefined) {
        const first = bulk.entries().next()
        if (!first.done) {
          bulk.delete(first.value[0])
          line = first.value[1]
        }
      }
      if (line !== undefined) {
        held -= Buffer.byteLength(line)
        out.write(line)
        continue
      }
      // Replies and streams last, taking turns; streams one line from each in turn: no stream starves another.
      const next = streams.entries().next()
      if (replies.length > 0 && (balance <= 0 || next.done)) {
        const r = replies.shift() as string
        const n = Buffer.byteLength(r)
        replyHeld -= n
        balance = next.done ? 0 : balance + n
        out.write(r)
        continue
      }
      if (next.done) break
      const [key, st] = next.value
      const head = st.lines.shift() as { line: string; seq: number; bytes: number }
      st.bytes -= head.bytes
      streamHeld -= head.bytes
      streams.delete(key)
      if (st.lines.length > 0) streams.set(key, st)
      balance = replies.length > 0 ? balance - head.bytes : 0
      out.write(head.line)
    }
    if (!dead && (control.length > 0 || bulk.size > 0 || replies.length > 0 || streams.size > 0) && !waiting) {
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
    stream: (key, line, seq, so = {}) => {
      if (dead) return
      const bytes = Buffer.byteLength(line)
      const st = streams.get(key) ?? { lines: [], bytes: 0 }
      st.lines.push({ line, seq, bytes })
      st.bytes += bytes
      streamHeld += bytes
      streams.set(key, st)
      const lose = (k: string): void => {
        const gone = streams.get(k)
        if (!gone || gone.lines.length === 0) return
        streams.delete(k)
        streamHeld -= gone.bytes
        o.onStreamOverflow?.(k, { firstSeq: gone.lines[0].seq, lastSeq: gone.lines[gone.lines.length - 1].seq })
      }
      if (!so.admit) {
        if (st.bytes > perKey) lose(key)
        else if (streamHeld + held > total) for (const k of [...streams.keys()]) lose(k)
      }
      if (!waiting) flush()
    },
    reply: (lines) => {
      if (dead) return true
      const bytes = lines.reduce((n, l) => n + Buffer.byteLength(l), 0)
      if (replyHeld + bytes > (o.replyCap ?? Number.POSITIVE_INFINITY)) return false
      replies.push(...lines)
      replyHeld += bytes
      if (!waiting) flush()
      return true
    },
    replyQueued: () => replyHeld,
    dropStream: (key) => {
      const st = streams.get(key)
      if (!st) return
      streams.delete(key)
      streamHeld -= st.bytes
    },
    queued: () => held + streamHeld + out.writableLength,
    destroy: () => {
      dead = true
      control.length = 0
      bulk.clear()
      streams.clear()
      streamHeld = 0
      held = 0
      replies.length = 0
      replyHeld = 0
    }
  }
}
