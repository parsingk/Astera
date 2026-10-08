// The live terminal (remote runtime design §3.7, C3 X1-02): a checkpoint plus the events after its watermark gives a
// fresh terminal the screen a continuously attached one shows. Each case compares against a reference terminal that
// was written every byte.
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { createLiveTerminal, TERMINAL_SCROLLBACK, type PtyCheckpoint } from './liveTerminal'
import { createPtyRing, type PtyEvent, type PtyEventInput } from './ptyRing'

const write = (t: Terminal, d: string): Promise<void> => new Promise((r) => t.write(d, r))

/** What a person sees on a terminal: both buffers' rows, which is active, the cursor, the colour of each cell. */
function look(t: Terminal): unknown {
  const rows = (b: typeof t.buffer.normal): string[] => {
    const out: string[] = []
    for (let y = 0; y < b.length; y++) {
      const line = b.getLine(y)
      let cells = ''
      for (let x = 0; line && x < t.cols; x++) {
        const c = line.getCell(x)
        if (c && c.getFgColor() !== 0) cells += `${x}:${c.getFgColor()},`
      }
      out.push(`${line?.translateToString(true) ?? ''}|${cells}`)
    }
    while (out.length > 0 && out[out.length - 1] === '|') out.pop()
    return out
  }
  return {
    active: t.buffer.active.type,
    // Whether the cursor shows (DECTCEM): not in the public API, read the way liveTerminal.ts reads it.
    hidden: (t as unknown as { _core: { coreService: { isCursorHidden: boolean } } })._core.coreService.isCursorHidden,
    cursor: [t.buffer.active.cursorX, t.buffer.active.cursorY],
    size: [t.cols, t.rows],
    normal: rows(t.buffer.normal),
    alternate: rows(t.buffer.alternate)
  }
}

/** Feeds `inputs` to a ring, a live terminal and a reference; takes a checkpoint after the first `cut` inputs, then
 *  answers the reference's look and that of a fresh terminal given the checkpoint and the events after it. */
async function recover(cols: number, rows: number, inputs: PtyEventInput[], cut: number): Promise<{ want: unknown; got: unknown; cp: PtyCheckpoint }> {
  const ring = createPtyRing({ bound: 10_000_000 })
  const live = createLiveTerminal({ cols, rows })
  const ref = new Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true })
  let cp: PtyCheckpoint | null = null
  for (let i = 0; i < inputs.length; i++) {
    if (i === cut) cp = await live.checkpoint()
    for (const e of ring.push(inputs[i])) {
      live.apply(e)
      if (e.kind === 'data') await write(ref, e.data)
      else if (e.kind === 'resize') ref.resize(e.cols, e.rows)
    }
  }
  if (cp === null) cp = await live.checkpoint()
  const fresh = new Terminal({ cols: cp.cols, rows: cp.rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true })
  await write(fresh, cp.state)
  await write(fresh, cp.pending)
  for (const e of ring.since(cp.watermark + 1) as PtyEvent[]) {
    if (e.kind === 'data') await write(fresh, e.data)
    else if (e.kind === 'resize') fresh.resize(e.cols, e.rows)
  }
  const out = { want: look(ref), got: look(fresh), cp }
  live.dispose()
  ref.dispose()
  fresh.dispose()
  return out
}

const data = (d: string): PtyEventInput => ({ kind: 'data', data: d })

describe('createLiveTerminal checkpoint', () => {
  it('a header painted long before the checkpoint is in it', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => data(`line ${i}\r\n`))
    const r = await recover(30, 8, [data('\x1b[1;32mHEADER\x1b[0m\r\n'), ...lines, data('after')], 20)
    expect(r.got).toEqual(r.want)
  })

  it('a CSI split across two events with the checkpoint between them', async () => {
    const r = await recover(30, 6, [data('plain \x1b[3'), data('1mred\x1b[0m done')], 1)
    expect(r.cp.pending).toBe('\x1b[3')
    expect(r.got).toEqual(r.want)
  })

  it('an OSC title split at the checkpoint', async () => {
    const r = await recover(30, 6, [data('a\x1b]0;ti'), data('tle\x07b')], 1)
    expect(r.cp.pending).toBe('\x1b]0;ti')
    expect(r.got).toEqual(r.want)
  })

  it('an alternate-screen program, checkpoint inside it and after it', async () => {
    const program = [data('shell$ vim\r\n'), data('\x1b[?1049h\x1b[H\x1b[2J'), data('~\r\n~\r\n\x1b[7mstatus\x1b[0m'), data('\x1b[3;1Hedit'), data('\x1b[?1049l'), data('shell$ ')]
    for (const cut of [3, 5]) {
      const r = await recover(24, 6, program, cut)
      expect(r.got).toEqual(r.want)
    }
  })

  it('a resize before or after the checkpoint keeps the width of rows painted before it', async () => {
    const inputs: PtyEventInput[] = [data('0123456789abcdefghij'), data('\r\n'), { kind: 'resize', cols: 10, rows: 5 }, data('after resize')]
    for (const cut of [2, 3, 4]) {
      const r = await recover(20, 5, inputs, cut)
      if (cut >= 3) expect([r.cp.cols, r.cp.rows]).toEqual([10, 5])
      expect(r.got).toEqual(r.want)
    }
  })

  it('a checkpoint after the exit carries its code', async () => {
    const r = await recover(20, 5, [data('bye'), { kind: 'exit', code: 3 }], 2)
    expect(r.cp.exitCode).toBe(3)
    expect(r.got).toEqual(r.want)
  })

  // Phase 8 review I1: state the serialize addon leaves out, which full-screen programs rely on.
  const E = String.fromCharCode(27)
  const NL = String.fromCharCode(13, 10)
  it('a scroll region set before the checkpoint still confines later output', async () => {
    const r = await recover(20, 8, [data(`top${NL}`), data(`${E}[3;6r${E}[6;1H`), data(`a${NL}b${NL}c${NL}d${NL}e${NL}`)], 2)
    expect(r.got).toEqual(r.want)
  })
  it('the DEC line-drawing charset active at the checkpoint still draws lines', async () => {
    const r = await recover(20, 4, [data(`${E}(0lqk`), data('x mj')], 1)
    expect(r.got).toEqual(r.want)
  })
  it('a shifted-in G1 charset stays shifted in', async () => {
    const r = await recover(20, 4, [data(`${E})0${String.fromCharCode(14)}lq`), data(`k${String.fromCharCode(15)}lq`)], 1)
    expect(r.got).toEqual(r.want)
  })
  it('a cursor saved before the checkpoint is restored after it', async () => {
    const r = await recover(20, 6, [data(`${E}[3;5H${E}7${E}[1;1Hhome`), data(`${E}8saved`)], 1)
    expect(r.got).toEqual(r.want)
  })
  it('origin mode set before the checkpoint still places the cursor within the region', async () => {
    const r = await recover(20, 8, [data(`${E}[3;7r${E}[?6h`), data(`${E}[2;2Hin`)], 1)
    expect(r.got).toEqual(r.want)
  })
  it('a hidden cursor stays hidden', async () => {
    const r = await recover(20, 4, [data(`${E}[?25lworking`), data('...')], 1)
    expect(r.got).toEqual(r.want)
  })

  it('reads the screen and the rows above it, as sessions-read answers', async () => {
    const live = createLiveTerminal({ cols: 20, rows: 3 })
    const ring = createPtyRing()
    for (const e of ring.push(data('one\r\ntwo\r\nthree\r\nfour'))) live.apply(e)
    const s = await live.read(10)
    expect(s.screen).toEqual(['two', 'three', 'four'])
    expect(s.scrollback).toEqual(['one'])
    live.dispose()
  })

  // R3 and O5: the budget for live terminals under heavy output. The numbers are printed for the spec.
  it('twenty terminals under 4 MiB of output each stay within the budget', async () => {
    const chunk = Array.from({ length: 200 }, (_, i) => `\x1b[3${i % 8}mrow ${i} ${'x'.repeat(60)}\x1b[0m\r\n`).join('')
    const each = 4 << 20
    const gc = (globalThis as { gc?: () => void }).gc
    gc?.()
    const before = process.memoryUsage().heapUsed
    // CPU time of this process, not the wall clock: a full suite on a loaded machine stretches the wall clock many
    // times over (21 s measured once against 1.3 s alone), while the work done stays what it is.
    const cpu0 = process.cpuUsage()
    const t0 = Date.now()
    const terms = Array.from({ length: 20 }, () => createLiveTerminal({ cols: 120, rows: 40 }))
    const ring = createPtyRing()
    for (let sent = 0; sent < each; sent += chunk.length) for (const t of terms) for (const e of ring.push(data(chunk))) t.apply(e)
    await Promise.all(terms.map((t) => t.checkpoint()))
    const ms = Date.now() - t0
    const cpu = process.cpuUsage(cpu0)
    const cpuMs = (cpu.user + cpu.system) / 1000
    gc?.()
    const mib = (process.memoryUsage().heapUsed - before) / (1 << 20)
    console.log(`live terminal budget: 20 x 4 MiB parsed in ${ms} ms (${cpuMs.toFixed(0)} ms CPU), heap +${mib.toFixed(1)} MiB`)
    expect(cpuMs).toBeLessThan(20_000)
    expect(mib).toBeLessThan(160)
    for (const t of terms) t.dispose()
  }, 120_000)
})
