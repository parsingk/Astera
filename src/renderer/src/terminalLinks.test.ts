import { describe, it, expect, vi } from 'vitest'
import { LATE_RECHECK_MS, attachConsoleLinks, cachedResolver } from './terminalLinks'

describe('cachedResolver', () => {
  it('a hit is cached: the same target is resolved once', async () => {
    const resolve = vi.fn(async () => 'D:\\out\\a.png')
    const r = cachedResolver(resolve, () => 0)
    expect(await r('a.png')).toBe('D:\\out\\a.png')
    expect(await r('a.png')).toBe('D:\\out\\a.png')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  // An agent prints the output path in its tool call before the file is written; the first hover
  // misses. A miss kept forever meant that path never became a link for the terminal's life.
  // D4 (2026-10-14): a file that is not there yet is asked again after 2 s, not 5
  it('remembers a miss for 2 s by default', async () => {
    let t = 0
    const resolve = vi.fn(async () => null)
    const r = cachedResolver(resolve, () => t)
    await r('a.txt')
    t = 1_999
    await r('a.txt')
    expect(resolve).toHaveBeenCalledTimes(1)
    t = 2_001
    await r('a.txt')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('a miss is remembered only briefly, then asked again', async () => {
    let now = 0
    const resolve = vi.fn(async (): Promise<string | null> => null)
    const r = cachedResolver(resolve, () => now, 5000)
    expect(await r('a.png')).toBeNull()
    now = 4999
    expect(await r('a.png')).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1) // still within the window: the hover storm is absorbed
    resolve.mockResolvedValueOnce('D:\\out\\a.png')
    now = 5000
    expect(await r('a.png')).toBe('D:\\out\\a.png')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('a rejection is a miss, with the same short memory', async () => {
    let now = 0
    const resolve = vi.fn(async (): Promise<string | null> => {
      throw new Error('ipc')
    })
    const r = cachedResolver(resolve, () => now, 5000)
    expect(await r('a.png')).toBeNull()
    now = 6000
    expect(await r('a.png')).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  // A hover over a name that missed asks again at once (the file may have just been written); what it finds is kept.
  it('fresh asks again inside the miss window, and keeps what it finds', async () => {
    let now = 0
    const resolve = vi.fn(async (): Promise<string | null> => null)
    const r = cachedResolver(resolve, () => now, 5000, 500)
    expect(await r('a.png')).toBeNull()
    resolve.mockResolvedValueOnce('/out/a.png')
    now = 500
    expect(await r.fresh('a.png')).toBe('/out/a.png')
    expect(await r('a.png')).toBe('/out/a.png')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  // Late-link review M1: a hover right after the miss that made the link, or one per repaint of a row a TUI keeps
  // redrawing, answers from the miss it has rather than asking main again.
  it('fresh within its floor of the last miss answers that miss', async () => {
    let now = 0
    const resolve = vi.fn(async (): Promise<string | null> => null)
    const r = cachedResolver(resolve, () => now, 5000, 500)
    expect(await r('a.png')).toBeNull()
    now = 499
    expect(await r.fresh('a.png')).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('fresh shares a request still in flight', async () => {
    let finish: (v: string | null) => void = () => {}
    const resolve = vi.fn(() => new Promise<string | null>((res) => (finish = res)))
    const r = cachedResolver(resolve, () => 0)
    const a = r('a.png')
    const b = r.fresh('a.png')
    finish('/out/a.png')
    expect([await a, await b]).toEqual(['/out/a.png', '/out/a.png'])
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('a request still in flight is shared, not repeated', async () => {
    let finish: (v: string | null) => void = () => {}
    const resolve = vi.fn(() => new Promise<string | null>((res) => (finish = res)))
    const r = cachedResolver(resolve, () => 0)
    const a = r('a.png')
    const b = r('a.png')
    finish('/out/a.png')
    expect(await a).toBe('/out/a.png')
    expect(await b).toBe('/out/a.png')
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})

/** Rows as text, or as text marked soft-wrapped (a continuation the terminal itself made). With `wideCells`, a Hangul,
 *  CJK or kana character takes two cells as in xterm: the character, then a cell of width 0 with no chars. */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60]/u
/** A row's cells as xterm lays them out: a wide character, then its trailing half; blanks to `cols`. */
const cellsOf = (text: string, cols: number): Array<{ width: number; chars: string }> => {
  const out: Array<{ width: number; chars: string }> = []
  for (const ch of text) {
    if (WIDE.test(ch)) out.push({ width: 2, chars: ch }, { width: 0, chars: '' })
    else out.push({ width: 1, chars: ch === ' ' ? '' : ch })
  }
  while (out.length < cols) out.push({ width: 1, chars: '' })
  return out
}

const fakeTerm = (lines: Array<string | { text: string; wrapped: true }>, cols: number, wideCells = false) => {
  let provider: { provideLinks: (y: number, cb: (links: unknown) => void) => void } | null = null
  const line = (row: string | { text: string; wrapped: true }) => {
    const text = typeof row === 'string' ? row : row.text
    return {
    isWrapped: typeof row !== 'string',
    length: cols,
    translateToString: () => text.padEnd(cols),
    getCell: (x: number) => {
      if (wideCells) {
        const cell = cellsOf(text, cols)[x]
        return cell === undefined ? undefined : { getWidth: () => cell.width, getChars: () => cell.chars }
      }
      const ch = text.padEnd(cols)[x]
      return ch === undefined ? undefined : { getWidth: () => 1, getChars: () => (ch === ' ' ? '' : ch) }
    }
    }
  }
  const term = {
    cols,
    options: {} as { linkHandler?: { activate: (event: MouseEvent, uri: string) => void } | null },
    buffer: { active: { getLine: (y: number) => (lines[y] === undefined ? undefined : line(lines[y])), getNullCell: () => ({}) } },
    registerLinkProvider: (p: typeof provider) => ((provider = p), { dispose: () => {} })
  }
  const links = (y: number) => new Promise<Array<{ text: string; range: unknown }> | undefined>((r) => provider!.provideLinks(y, r as never))
  return { term, links }
}

// Claude Code prints an artifact's address as an OSC 8 hyperlink. With no linkHandler xterm opens those itself: a
// blocking confirm() that froze the window, then window.open(), which Electron refuses, so nothing opened (bug report,
// 2026-11-19). They take the printed URL's way instead, with the click's modifiers.
describe('attachConsoleLinks and OSC 8 hyperlinks', () => {
  it('hands an OSC 8 link to onUrl with its mouse event', () => {
    const f = fakeTerm([''], 10)
    const opened: Array<[string, boolean]> = []
    attachConsoleLinks(f.term as never, { onUrl: (url, ev) => opened.push([url, ev.ctrlKey]) })
    const handler = f.term.options.linkHandler
    expect(handler).toBeTruthy()
    handler!.activate({ ctrlKey: true } as MouseEvent, 'https://claude.ai/artifact/VwWHC1xLtetTs8WiBggwiN')
    expect(opened).toEqual([['https://claude.ai/artifact/VwWHC1xLtetTs8WiBggwiN', true]])
  })
})

// A path Claude Code cut at the right edge and went on with after its indentation (core/run/consoleLinks.ts
// joinCutLines) is one link, across the rows it takes, when the whole of it names a file.
describe('attachConsoleLinks across a cut path', () => {

  it('links the whole path from any row it is on, and not the pieces', async () => {
    const PATH = 'C:\\Users\\anipen\\AppData\\Roaming\\astera-dev\\preview\\shots\\app-226bd0e8.png'
    const cols = 30
    const f = fakeTerm(['  "' + PATH.slice(0, 27), '    ' + PATH.slice(27, 53), '    ' + PATH.slice(53) + '",'], cols)
    const resolved: string[] = []
    attachConsoleLinks(f.term as never, {
      onUrl: () => {},
      resolvePath: async (target) => (resolved.push(target), target === PATH ? PATH : null)
    })
    for (const y of [1, 2, 3]) {
      const got = await f.links(y)
      expect(got?.map((l) => [l.text, l.range]), String(y)).toEqual([[PATH, { start: { x: 4, y: 1 }, end: { x: 24, y: 3 } }]])
    }
    expect(resolved).toContain(PATH)
  })

  const attach = (f: ReturnType<typeof fakeTerm>, files: string[]) =>
    attachConsoleLinks(f.term as never, { onUrl: () => {}, resolvePath: async (target) => (files.includes(target) ? target : null) })
  const PATH = 'C:\\Users\\anipen\\AppData\\Roaming\\astera-dev\\preview\\shots\\app-226bd0e8.png'

  // Final review I1: xterm drops a row's links that another row's link overlaps, so a cut path on the rows below must
  // not be handed back for this row: its own link stays.
  it("keeps the row's own link when a cut path starts on the next row", async () => {
    const A = 'C:\\Users\\anipen\\x\\a.png'
    const f = fakeTerm(['  "' + A + '",', '  "' + PATH.slice(0, 26), '    ' + PATH.slice(26, 52), '    ' + PATH.slice(52) + '",'], 30)
    attach(f, [A, PATH])
    expect((await f.links(1))?.map((l) => l.text)).toEqual([A])
    expect((await f.links(3))?.map((l) => l.text)).toEqual([PATH])
  })

  // Final review I2: a link the first row names by itself is not lengthened by the next row's first word.
  it('does not lengthen a link the first row names by itself', async () => {
    const f = fakeTerm(['  see lib/app.py:125', '  4. next'], 20)
    attach(f, ['lib/app.py'])
    const got = await f.links(1)
    expect(got?.map((l) => l.text)).toEqual(['lib/app.py'])
    expect(got?.[0].range).toEqual({ start: { x: 7, y: 1 }, end: { x: 20, y: 1 } })
    expect(await f.links(2)).toBeUndefined()
  })

  it('still links a path the terminal wrapped itself, once, and a path on one row', async () => {
    const wrapped = fakeTerm(['  ' + PATH.slice(0, 28), { text: PATH.slice(28, 58), wrapped: true }, { text: PATH.slice(58), wrapped: true }], 30)
    attach(wrapped, [PATH])
    for (const y of [1, 2, 3]) expect((await wrapped.links(y))?.map((l) => l.text), String(y)).toEqual([PATH])
    const one = fakeTerm(['  open D:\\x\\a.png now'], 40)
    attach(one, ['D:\\x\\a.png'])
    expect((await one.links(1))?.map((l) => l.text)).toEqual(['D:\\x\\a.png'])
  })
})

// Bug report, 2026-10-14: a Korean sentence glued its ending to a path (`...concept_vs_app.png입니다.`), and that link
// did not open, while the same path at the end of a line did. The whole token is tried first, then the path without
// the glued word (core/run/consoleLinks.ts GLUED_WORD), over its own cells.
describe('attachConsoleLinks with a word glued to a path', () => {
  type Link = { text: string; range: unknown; decorations?: { underline: boolean; pointerCursor: boolean }; activate: (e: unknown, t: string) => void }
  const setup = (lines: string[], files: string[], cols = 60, wideCells = false) => {
    const f = fakeTerm(lines, cols, wideCells)
    const opened: string[] = []
    const asked: string[] = []
    attachConsoleLinks(f.term as never, {
      onUrl: () => {},
      resolvePath: async (target) => (asked.push(target), files.includes(target) ? `/abs/${target}` : null),
      onOpenFile: (p) => opened.push(p)
    })
    return { links: (y = 1) => f.links(y) as Promise<Link[] | undefined>, opened, asked }
  }

  it('links the path without the glued ending when only that names a file, over its own cells', async () => {
    const s = setup(['마지막 장은 C:\\a\\b.png입니다.'], ['C:\\a\\b.png'])
    const got = await s.links()
    expect(got?.map((l) => [l.text, l.range])).toEqual([['C:\\a\\b.png', { start: { x: 8, y: 1 }, end: { x: 17, y: 1 } }]])
    got![0].activate(undefined, got![0].text)
    expect(s.opened).toEqual(['/abs/C:\\a\\b.png'])
    expect(s.asked).toEqual(['C:\\a\\b.png입니다', 'C:\\a\\b.png'])
  })

  it('links the whole token when the whole names a file', async () => {
    const s = setup(['열기: C:\\문서\\보고서'], ['C:\\문서\\보고서', 'C:\\문서\\'])
    expect((await s.links())?.map((l) => l.text)).toEqual(['C:\\문서\\보고서'])
  })

  it('links nothing when neither names a file and it is no media name', async () => {
    const s = setup(['C:\\a\\notes.txt입니다'], [])
    expect(await s.links()).toBeUndefined()
  })

  it('hands a media name glued to a word, not found yet, as an unmarked link over the name alone', async () => {
    const s = setup(['C:\\a\\b.png입니다.'], [])
    const [link] = (await s.links()) ?? []
    expect([link.text, link.range, link.decorations]).toEqual(['C:\\a\\b.png', { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } }, { underline: false, pointerCursor: false }])
  })

  // Review m3: in xterm a Korean character takes two cells, so the path's cells are not its characters' indexes
  it('links the path over its own cells when Korean characters take two cells each', async () => {
    const s = setup(['마지막 장은 C:\\a\\b.png입니다.'], ['C:\\a\\b.png'], 60, true)
    // 마지막(6) 장은(4) and two spaces: the path starts in cell 13
    expect((await s.links())?.map((l) => [l.text, l.range])).toEqual([['C:\\a\\b.png', { start: { x: 13, y: 1 }, end: { x: 22, y: 1 } }]])
  })

  it('links a glued path a TUI cut across rows, Korean characters taking two cells', async () => {
    const PATH = 'C:\\Users\\anipen\\terraluen-review\\concept_vs_app.png'
    const s = setup(['장 ' + PATH.slice(0, 25), '  ' + PATH.slice(25) + '입니다.'], [PATH], 28, true)
    expect((await s.links(2))?.map((l) => [l.text, l.range])).toEqual([[PATH, { start: { x: 4, y: 1 }, end: { x: 2 + PATH.length - 25, y: 2 } }]])
  })

  it('links a glued path a TUI cut across rows', async () => {
    const PATH = 'C:\\Users\\anipen\\terraluen-review\\concept_vs_app.png'
    const s = setup(['  ' + PATH.slice(0, 28), '  ' + PATH.slice(28) + '입니다.'], [PATH], 30)
    expect((await s.links(2))?.map((l) => [l.text, l.range])).toEqual([[PATH, { start: { x: 3, y: 1 }, end: { x: 2 + PATH.length - 28, y: 2 } }]])
  })
})

// The 2026-10-14 investigation: readings that start inside a token, quoted paths with spaces, and folders.
describe('attachConsoleLinks with several readings, quotes and folders', () => {
  type Link = { text: string; range: unknown; activate: (e: unknown, t: string) => void }
  const setup = (line: string, answers: Record<string, string | { path: string; dir: true }>, withFolders = true) => {
    const f = fakeTerm([line], 80)
    const files: string[] = []
    const folders: string[] = []
    attachConsoleLinks(f.term as never, {
      onUrl: () => {},
      resolvePath: async (target) => answers[target] ?? null,
      onOpenFile: (p) => files.push(p),
      ...(withFolders ? { onOpenFolder: (p: string) => folders.push(p) } : {})
    })
    return { links: () => f.links(1) as Promise<Link[] | undefined>, files, folders }
  }

  it('links the path inside a markdown image over its own cells', async () => {
    const line = '![C6-1a 스틸](D:\\a\\b.png)'
    const s = setup(line, { 'D:\\a\\b.png': '/abs/b.png' })
    const at = line.indexOf('D:')
    expect((await s.links())?.map((l) => [l.text, l.range])).toEqual([['D:\\a\\b.png', { start: { x: at + 1, y: 1 }, end: { x: at + 10, y: 1 } }]])
  })

  // Review Focus 3: two links over the same cells reach xterm as one, the longest
  it('keeps one link, the longest, where a quoted path and a word inside it both resolve', async () => {
    const s = setup('"C:\\Program Files\\a.txt"', { 'C:\\Program Files\\a.txt': '/pf/a.txt', 'Files\\a.txt': '/cwd/Files/a.txt' })
    expect((await s.links())?.map((l) => l.text)).toEqual(['C:\\Program Files\\a.txt'])
  })

  it('links a folder to the folder opener', async () => {
    const s = setup('읽어 보세요: C:\\a\\specs\\에 있습니다', { 'C:\\a\\specs\\': { path: 'C:\\a\\specs', dir: true } })
    const got = await s.links()
    expect(got?.map((l) => l.text)).toEqual(['C:\\a\\specs\\'])
    got![0].activate(undefined, got![0].text)
    expect([s.folders, s.files]).toEqual([['C:\\a\\specs'], []])
  })

  // Final review I1: a TUI-cut path whose first row's word is a folder is still linked whole across the rows; only a
  // first row that names a FILE by itself keeps its own link (final review I2 of the cut-path work)
  it('links a cut path whole when its first row names a folder', async () => {
    const FULL = 'C:\\Users\\anipen\\review\\a.png'
    const f = fakeTerm(['  C:\\Users\\anipen\\', '  review\\a.png'], 20)
    attachConsoleLinks(f.term as never, {
      onUrl: () => {},
      resolvePath: async (t) => (t === FULL ? FULL : t === 'C:\\Users\\anipen\\' ? { path: 'C:\\Users\\anipen', dir: true } : null),
      onOpenFile: () => {},
      onOpenFolder: () => {}
    })
    for (const y of [1, 2]) expect((await f.links(y))?.map((l) => l.text), String(y)).toEqual([FULL])
  })

  // Final review I3: an unmarked late link (a media name not found yet) never hides a link that resolved
  it('keeps the links that resolved over a longer late link around them', async () => {
    const s = setup('"/tmp/a.png is done, see /tmp/b.png"', { '/tmp/a.png': '/tmp/a.png', '/tmp/b.png': '/tmp/b.png' })
    expect((await s.links())?.map((l) => l.text)).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })

  it('gives no link to a folder when nothing opens folders', async () => {
    const s = setup('C:\\a\\specs\\', { 'C:\\a\\specs\\': { path: 'C:\\a\\specs', dir: true } }, false)
    expect(await s.links()).toBeUndefined()
  })
})

// A media file named before it exists (an agent's message, then the tool call that writes or copies it): xterm keeps a
// row's links while the pointer stays on that row, so a name that was no link at its first hover stayed none though the
// file was there a moment later (bug report, 2026-10-13).
describe('attachConsoleLinks with a media file that appears after its name was printed', () => {
  type Decorations = { underline: boolean; pointerCursor: boolean }
  type Link = { text: string; decorations?: Decorations; hover?: (e: unknown, t: string) => void; leave?: (e: unknown, t: string) => void; activate: (e: unknown, t: string) => void }

  /** xterm's Linkifier as far as these links meet it: on hover the state takes the link's decorations, `hover` runs,
   *  and `link.decorations` becomes setters on the state of xterm's *current* link (Linkifier.ts, _handleNewLink). */
  const xterm = () => {
    const states = new Map<Link, Decorations>()
    let current: Link | null = null
    return {
      states,
      hover(link: Link) {
        current = link
        states.set(link, { underline: link.decorations?.underline ?? true, pointerCursor: link.decorations?.pointerCursor ?? true })
        link.hover?.(undefined, link.text)
        const decorations = {} as Decorations
        for (const key of ['underline', 'pointerCursor'] as const)
          Object.defineProperty(decorations, key, {
            get: () => (current ? states.get(current)?.[key] : undefined),
            set: (v: boolean) => {
              const s = current ? states.get(current) : undefined
              if (s) s[key] = v
            }
          })
        link.decorations = decorations
      },
      leave(link: Link) {
        link.leave?.(undefined, link.text)
        current = null
      },
      /** xterm activates only the link the pointer is on. */
      click(link: Link) {
        if (current === link) link.activate(undefined, link.text)
      }
    }
  }

  const setup = (line: string, resolve: (target: string) => Promise<string | null>) => {
    const f = fakeTerm([line], 60)
    const opened: string[] = []
    const asked: string[] = []
    attachConsoleLinks(f.term as never, {
      onUrl: () => {},
      resolvePath: (target) => (asked.push(target), resolve(target)),
      onOpenFile: (p) => opened.push(p)
    })
    return { links: () => f.links(1) as Promise<Link[] | undefined>, opened, asked }
  }
  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms))

  it('hands a media name it cannot find yet as a link with no underline and no pointer, which opens nothing', async () => {
    const s = setup('  - copied original: b.png', async () => null)
    const [link] = (await s.links()) ?? []
    expect([link.text, link.decorations]).toEqual(['b.png', { underline: false, pointerCursor: false }])
    const x = xterm()
    x.hover(link)
    await settle()
    x.click(link)
    await settle()
    expect(x.states.get(link)).toEqual({ underline: false, pointerCursor: false })
    expect(s.opened).toEqual([])
  })

  it('marks it when the pointer comes back and the file is there, and then opens it', async () => {
    const files: string[] = []
    const s = setup('  - copied original: b.png', async (t) => (files.includes(t) ? `/out/${t}` : null))
    const [link] = (await s.links()) ?? []
    const x = xterm()
    x.hover(link)
    await settle()
    x.leave(link)
    files.push('b.png')
    // Past the floor that keeps a hover storm from asking main on every repaint.
    await settle(LATE_RECHECK_MS + 20)
    x.hover(link)
    await settle()
    expect(x.states.get(link)).toEqual({ underline: true, pointerCursor: true })
    x.click(link)
    await settle()
    expect(s.opened).toEqual(['/out/b.png'])
    // Found once, it is not asked about again however often the pointer comes back.
    const asked = s.asked.length
    x.leave(link)
    x.hover(link)
    await settle()
    expect(s.asked).toHaveLength(asked)
    // And when xterm asks for the row again (another row, then back), it is a plain link.
    expect((await s.links())?.map((l) => [l.text, l.decorations])).toEqual([['b.png', undefined]])
  })

  // Final review M2: nothing opens that was never shown as a link: a click on a name still unmarked opens nothing,
  // though its file was written meanwhile.
  it('opens nothing on a click while it is unmarked, though the file is there now', async () => {
    const files: string[] = []
    const s = setup('  - copied original: b.png', async (t) => (files.includes(t) ? `/out/${t}` : null))
    const [link] = (await s.links()) ?? []
    const x = xterm()
    x.hover(link)
    await settle()
    files.push('b.png')
    x.click(link)
    await settle()
    expect(s.opened).toEqual([])
  })

  // xterm's setters act on its current link: a mark set after the pointer moved on would mark that other link.
  it('marks nothing when the pointer left before the file was found', async () => {
    let finish: () => void = () => {}
    let calls = 0
    const s = setup('  - copied original: b.png  c.png', (t) =>
      t === 'c.png' ? Promise.resolve('/out/c.png') : ++calls === 1 ? Promise.resolve(null) : new Promise((r) => (finish = () => r(`/out/${t}`)))
    )
    const got = (await s.links()) ?? []
    const late = got.find((l) => l.text === 'b.png')!
    const other = got.find((l) => l.text === 'c.png')!
    const x = xterm()
    await settle(LATE_RECHECK_MS + 20)
    x.hover(late)
    x.leave(late)
    x.hover(other)
    x.states.set(other, { underline: false, pointerCursor: false })
    finish()
    await settle()
    expect(x.states.get(other)).toEqual({ underline: false, pointerCursor: false })
  })

  // Final review I1: an unmarked link is xterm's current link, and xterm's double-click selects a current link whole,
  // so only a media name gets one; a path that is no file stays plain text, its double-click a word as before.
  it('gives no unmarked link to a name that is not media', async () => {
    const s = setup('  edit src/a.ts,src/b.ts now', async () => null)
    expect(await s.links()).toBeUndefined()
  })

  it('hands a media name it finds at once as a plain link, as before', async () => {
    const s = setup('  - background: a.png', async (t) => `/out/${t}`)
    const got = await s.links()
    expect(got?.map((l) => [l.text, l.decorations])).toEqual([['a.png', undefined]])
  })
})
