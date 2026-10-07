// The agent app workspace on a real Windows desktop (spec, Testing, "Windows, real"). Gated twice: it
// needs win32 and ASTERA_DESKTOP_E2E=1, because it launches Electron and creates a desktop object. It
// never switches desktops, so it takes nothing from whoever sits at the machine, and that is what it
// checks: the foreground window is the same before and after every script, no fixture window ever shows
// on the person's desktop, and nothing is left running once the workspace is closed or its helper dies.
//
// The clipboard is shared (W1), so `paste()` reads the person's clipboard. When it holds plain text or
// nothing, the test puts a marker there for the paste and puts the person's text back afterwards (only
// if the marker is still there, so a copy made meanwhile is kept). When it holds anything richer (an
// image, files, HTML), the test leaves it alone and checks the paste against its text. When this
// process may not open the clipboard at all (a sandboxed shell), neither may the fixture it starts:
// the clipboard is left alone and the paste must still arrive as a trusted event, with no text.
//
// The helper starts with the production ready timeout (DESK_READY_MS, 5 s; preflight ruling F3).
import { describe, it, expect, afterAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostWorkerBaseEnv } from '../../core/host/spawn'
import { createLaunchResolver } from './launch'
import { createWorkspaceManager, type WorkspaceEvent, type WorkspaceManager } from './manager'
import { spawnPowerShell, startDesktopHelper, writeDeskScript, type DesktopHelper } from './desktopHelper'
import { connectCdp } from './cdp'
import { electronExe, exists, read2 } from './e2eSupport'
import { freePort, killTree, processStartTimes } from './native'

const here = path.dirname(fileURLToPath(import.meta.url))
const enabled = process.platform === 'win32' && process.env.ASTERA_DESKTOP_E2E === '1'
const TITLE = 'Astera workspace fixture'

const ps = (script: string): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 }, (err, out) =>
      err ? reject(err) : resolve(String(out).trim())
    )
  )

/** A string into a PowerShell expression without any quoting to get wrong. */
const psString = (s: string): string => `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(s, 'utf8').toString('base64')}')))`

const foreground = (): Promise<string> =>
  ps(
    `Add-Type -Namespace E2E -Name Fg -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'; ` +
      `[E2E.Fg]::GetForegroundWindow().ToInt64()`
  )

/** Pids of the Electron processes started with this user data folder, wherever their parent went. */
const fixturePids = async (udd: string): Promise<number[]> => {
  const out = await ps(
    `@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${psString(udd)}) } | ForEach-Object { $_.ProcessId }) -join ','`
  )
  return out === '' ? [] : out.split(',').map(Number)
}

/** Fixture windows the person's desktop can see: Get-Process reads MainWindowTitle on the caller's desktop. */
const fixtureTitledOnMyDesktop = async (): Promise<number> =>
  Number(await ps(`@(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${TITLE}*' }).Count`))

/** Every top level window on the caller's (the person's) desktop that belongs to one of `pids`,
 *  visible or not: EnumWindows walks only the calling thread's desktop. */
const windowsOnMyDesktop = async (pids: number[]): Promise<number> => {
  if (pids.length === 0) return 0
  const source = [
    'using System; using System.Collections.Generic; using System.Runtime.InteropServices;',
    'public static class E2EWins {',
    '  public delegate bool P(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(P cb, IntPtr l);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  public static int[] Pids() { List<int> o = new List<int>(); EnumWindows(delegate (IntPtr h, IntPtr l) { uint p; GetWindowThreadProcessId(h, out p); o.Add((int)p); return true; }, IntPtr.Zero); return o.ToArray(); }',
    '}'
  ].join('\n')
  return Number(
    await ps(
      `Add-Type -TypeDefinition ${psString(source)}; $want = @(${pids.join(',')}); @([E2EWins]::Pids() | Where-Object { $want -contains $_ }).Count`
    )
  )
}

type ClipboardState = { formats: string[]; text: string | null } | { denied: string }

/** What the clipboard holds, or why it cannot be opened. A process whose token may not open the
 *  clipboard (a sandboxed agent shell: OpenClipboard answers ERROR_ACCESS_DENIED) is told so after a
 *  few tries, so a clipboard held open for a moment by another program is not mistaken for that. */
const clipboardState = async (): Promise<ClipboardState> => {
  let denied = ''
  for (let i = 0; i < 3; i++) {
    const json = await ps(
      "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Windows.Forms; try { " +
        '$o = [Windows.Forms.Clipboard]::GetDataObject(); $f = @(); if ($o) { $f = @($o.GetFormats()) }; ' +
        '$t = $null; if ([Windows.Forms.Clipboard]::ContainsText()) { $t = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Windows.Forms.Clipboard]::GetText())) }; ' +
        'ConvertTo-Json -Compress -InputObject @{ formats = $f; text = $t } ' +
        "} catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; ConvertTo-Json -Compress -InputObject @{ denied = ('0x{0:X8} {1}' -f $e.HResult, $e.GetType().Name) } }"
    )
    const v = JSON.parse(json) as { formats?: string[] | string | null; text?: string | null; denied?: string }
    if (typeof v.denied !== 'string') {
      const formats = v.formats == null ? [] : Array.isArray(v.formats) ? v.formats : [v.formats]
      return { formats, text: v.text == null ? null : Buffer.from(v.text, 'base64').toString('utf8') }
    }
    denied = v.denied
    await new Promise((r) => setTimeout(r, 300))
  }
  return { denied }
}

/** Formats Windows derives from plain text; a clipboard holding only these is plain text. */
const TEXT_FORMATS = new Set(['Text', 'UnicodeText', 'System.String', 'OEMText', 'Locale'])

const setClipboardText = (text: string | null): Promise<string> =>
  ps(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
      (text === null || text === '' ? '[Windows.Forms.Clipboard]::Clear()' : `[Windows.Forms.Clipboard]::SetDataObject(${psString(text)}, $true, 10, 100)`)
  )

const commandFor = (udd: string, extra = ''): string =>
  `"${electronExe()}" "${path.join(here, 'fixtures', 'app', 'main.cjs')}" --remote-debugging-port=%ASTERA_APP_CDP_PORT% --user-data-dir="${udd}"${extra}`

interface Harness {
  m: WorkspaceManager
  events: WorkspaceEvent[]
  helpers: DesktopHelper[]
  /** How long each helper took from spawn to a created desktop, ms. */
  startMs: number[]
  log: string[]
  recordFile: string
}

const harness = async (profile: string): Promise<Harness> => {
  await fs.mkdir(profile, { recursive: true })
  const h: Harness = { m: undefined as unknown as WorkspaceManager, events: [], helpers: [], startMs: [], log: [], recordFile: path.join(profile, 'orch', 'workspaces.json') }
  h.m = createWorkspaceManager({
    platform: process.platform,
    env: process.env,
    recordFile: h.recordFile,
    shotsDir: path.join(profile, 'preview', 'shots'),
    enabled: async () => true,
    guide: () => '',
    sessionCwd: async () => path.join(here, 'fixtures', 'app'),
    resolveLaunch: createLaunchResolver({
      runConfigsFile: path.join(profile, 'run-configs.json'),
      platform: process.platform,
      baseEnv: () => hostWorkerBaseEnv(process.env),
      projectRoot: async (c) => c
    }),
    startDesk: async (name) => {
      const script = await writeDeskScript(path.join(profile, 'host'))
      const t0 = Date.now()
      // No readyMs: the production DESK_READY_MS (preflight ruling F3).
      const desk = await startDesktopHelper({ name, spawn: () => spawnPowerShell(script), log: (m) => h.log.push(m) })
      h.startMs.push(Date.now() - t0)
      h.helpers.push(desk)
      return desk
    },
    connectCdp: (port, waitMs) => connectCdp(port, waitMs),
    freePort,
    killTree: (pid) => killTree(pid),
    startTimes: (pids) => processStartTimes(pids),
    emit: (e) => h.events.push(e),
    hasWatchers: () => true,
    log: (m) => h.log.push(m)
  })
  return h
}

const recordedPids = async (recordFile: string): Promise<number[]> => {
  const record = JSON.parse(await fs.readFile(recordFile, 'utf8')) as { workspaces: Array<{ pids: Array<{ pid: number }> }> }
  return record.workspaces[0].pids.map((p) => p.pid)
}

describe.runIf(enabled)('the agent app workspace on a real desktop', () => {
  let dir = ''
  const managers: WorkspaceManager[] = []
  const udds: string[] = []
  afterAll(async () => {
    // A failed run must not leave anything behind either: the managers end what they hold, then any
    // fixture process this run started (found by its own user data folder) is ended by pid.
    for (const m of managers) await m.dispose().catch(() => undefined)
    for (const udd of udds) for (const pid of await fixturePids(udd).catch(() => [])) await killTree(pid).catch(() => undefined)
    if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }, 60_000)

  const tempDir = async (): Promise<string> => {
    if (!dir) dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-데스크톱 e2e-'))
    return dir
  }

  it(
    'launches, drives, photographs and closes the fixture without touching the person desktop',
    async () => {
      const base = await tempDir()
      const profile = path.join(base, 'profile')
      const udd = path.join(base, 'electron-profile')
      udds.push(udd)
      const dropped = path.join(base, 'drop me.txt')
      await fs.writeFile(dropped, 'x', 'utf8')
      const h = await harness(profile)
      managers.push(h.m)
      const { m, events } = h

      const before = await foreground()

      // 1. Launch, and look.
      const first = await m.run('s-e2e', `log(await launch({ command: ${JSON.stringify(commandFor(udd))} })); log((await snapshot()).title)`)
      expect(first.status).toBe(200)
      const firstBody = first.body as { log: string[]; error?: unknown }
      expect(firstBody.error).toBeUndefined()
      expect(firstBody.log[1]).toBe(TITLE)
      console.log(`desktop helper cold start (spawn to created desktop): ${h.startMs.join(', ')} ms`)
      expect(await foreground()).toBe(before)
      const running = await fixturePids(udd)
      expect(running.length).toBeGreaterThan(0)
      expect(await fixtureTitledOnMyDesktop()).toBe(0)
      expect(await windowsOnMyDesktop(running)).toBe(0)
      await vi.waitFor(async () => expect(await recordedPids(h.recordFile)).toHaveLength(2))
      const pids = await recordedPids(h.recordFile)
      expect(pids[1]).toBe(h.helpers[0].pid)
      const port = (JSON.parse(firstBody.log[0]) as { port: number }).port

      // 2. Drive it: click, a real paste, an in-page drag, a file drop, native keys, both captures.
      const clip = await clipboardState()
      const plain = !('denied' in clip) && clip.formats.every((f) => TEXT_FORMATS.has(f))
      const marker = `Astera e2e 붙여넣기 ${Date.now()}\nline two`
      console.log(
        'denied' in clip
          ? `clipboard before the paste: this process may not open it (${clip.denied}); left alone, and the fixture, started from here, reads it as empty`
          : `clipboard before the paste: formats [${clip.formats.join(', ')}]; ${plain ? 'plain text or empty: a marker is put there and the text restored after' : 'richer content: left alone'}`
      )
      let second: Awaited<ReturnType<WorkspaceManager['run']>>
      let pastedFrom: string
      try {
        // Inside the try (final review, T10 minor): a set that fails after the marker landed (a timeout
        // in PowerShell after SetDataObject) is still put back by the finally, which restores only
        // while the marker is there.
        if (plain) await setClipboardText(marker)
        second = await m.run(
          's-e2e',
          [
            "await click('#b')",
            "await click('#t')",
            'await paste()',
            "await drag('#src', '#dst')",
            `await dropFiles('#drop', [${JSON.stringify(dropped)}])`,
            "await click('#t')",
            `await keys('${TITLE}', 'hi')`,
            'await waitFor(300)',
            'log(await windows())',
            'log(await windowShot())',
            'log(await screenshot())'
          ].join('\n')
        )
        pastedFrom = plain ? marker : 'denied' in clip ? '' : (clip.text ?? '')
      } finally {
        if (plain) {
          // Right after a paste the clipboard can be held for a moment by another program (Windows'
          // clipboard history, the fixture), and a read can come back with CRLF line ends. So the
          // read is retried for a few seconds and compared with its line ends normalised; without
          // this the person's text was left replaced by the marker (seen on a real desktop).
          const lf = (s: string): string => s.replace(/\r\n/g, '\n')
          let now: ClipboardState | null = null
          for (let i = 0; i < 10; i++) {
            now = await clipboardState().catch(() => null)
            if (now && 'text' in now) break
            await new Promise((r) => setTimeout(r, 300))
          }
          if (now && 'text' in now && now.text !== null && lf(now.text) === lf(marker))
            await setClipboardText('text' in clip ? clip.text : null)
          else
            console.log(
              `the clipboard was not restored: ${now === null ? 'it could not be read' : 'denied' in now ? `it could not be opened (${now.denied})` : 'it no longer holds the marker, so the new content is kept'}`
            )
        }
      }
      const body = second.body as { log: string[]; error?: unknown }
      expect(body.error).toBeUndefined()
      const [windowsLine, windowShotLine, screenshotLine] = body.log
      expect(JSON.parse(windowsLine)).toEqual(expect.arrayContaining([expect.objectContaining({ title: TITLE })]))
      for (const line of [windowShotLine, screenshotLine]) {
        const shot = JSON.parse(line) as { path: string; width: number; height: number }
        expect(shot.width).toBeGreaterThan(100)
        expect((await fs.stat(shot.path)).size).toBeGreaterThan(1000)
      }
      // What the page saw, read over a second CDP client of the same port (the script API has no
      // evaluate, on purpose).
      const recorded = JSON.parse(String(await read2(port, 'JSON.stringify(window.events)'))) as Array<Record<string, unknown>>
      expect(await read2(port, "document.getElementById('out').textContent")).toBe('clicked')
      const paste = recorded.find((e) => e.kind === 'paste')
      expect(paste?.trusted).toBe(true)
      const crlf = (x: string): string => x.replace(/\r\n/g, '\n')
      expect(crlf(String(paste?.text ?? ''))).toBe(crlf(pastedFrom))
      expect(recorded).toEqual(expect.arrayContaining([{ kind: 'drop', text: 'card-1' }, { kind: 'files', names: ['drop me.txt'] }]))
      expect(String(await read2(port, "document.getElementById('t').value"))).toMatch(/hi$/)
      expect(events.some((e) => e.kind === 'frame')).toBe(true)
      expect(await foreground()).toBe(before)
      expect(await fixtureTitledOnMyDesktop()).toBe(0)
      expect(await windowsOnMyDesktop(await fixturePids(udd))).toBe(0)

      // 3. Close, and nothing is left: not the launched tree, not the helper, not the record.
      const third = await m.run('s-e2e', 'await close()')
      expect((third.body as { error?: unknown }).error).toBeUndefined()
      await m.dispose()
      expect(h.helpers[0].alive()).toBe(false)
      expect((await processStartTimes(pids)).size).toBe(0)
      expect(await fixturePids(udd)).toEqual([])
      expect(await exists(h.recordFile)).toBe(false)
      expect(events.filter((e) => e.kind === 'state').at(-1)).toMatchObject({ open: false })
      expect(await foreground()).toBe(before)
    },
    180_000
  )

  it(
    'lays out the page of a window that maximized itself at the mirror tab size, so the page, its metrics and the capture agree',
    async () => {
      const base = await tempDir()
      const profile = path.join(base, 'profile-3')
      const udd = path.join(base, 'electron-profile-3')
      udds.push(udd)
      const h = await harness(profile)
      managers.push(h.m)
      const before = await foreground()
      const page = 'JSON.stringify({ w: innerWidth, h: innerHeight, cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight, dpr: devicePixelRatio })'
      type Page = { w: number; h: number; cw: number; ch: number; dpr: number }

      expect(h.m.resize('s-e2e-3', { width: 1200, height: 750 })).toBe(true)
      const first = await h.m.run('s-e2e-3', `log(await launch({ command: ${JSON.stringify(commandFor(udd, ' --maximize'))} })); log(await screenshot())`)
      const firstBody = first.body as { log: string[]; error?: unknown }
      expect(firstBody.error).toBeUndefined()
      const port = (JSON.parse(firstBody.log[0]) as { port: number }).port
      const shot = JSON.parse(firstBody.log[1]) as { width: number; height: number }
      const p1 = JSON.parse(String(await read2(port, page))) as Page
      console.log(`a self-maximizing launch sized for 1200x750: page ${JSON.stringify(p1)}, screenshot ${shot.width}x${shot.height}; ${h.log.filter((l) => l.includes('the app was given')).join(' | ')}`)
      expect([p1.w, p1.h, p1.cw, p1.ch]).toEqual([1200, 750, 1200, 750])
      expect([shot.width, shot.height]).toEqual([Math.round(1200 * p1.dpr), Math.round(750 * p1.dpr)])

      // The tab resized: the running app follows.
      expect(h.m.resize('s-e2e-3', { width: 1000, height: 640 })).toBe(true)
      await vi.waitFor(async () => expect(JSON.parse(String(await read2(port, page)))).toMatchObject({ w: 1000, h: 640, cw: 1000, ch: 640 }), { timeout: 10_000, interval: 300 })
      // The capture follows the page's new layout within a frame or two (measured: under 500 ms).
      await vi.waitFor(
        async () => {
          const again = await h.m.run('s-e2e-3', 'log(await screenshot())')
          expect(JSON.parse((again.body as { log: string[] }).log[0])).toMatchObject({ width: Math.round(1000 * p1.dpr), height: Math.round(640 * p1.dpr) })
        },
        { timeout: 10_000, interval: 500 }
      )
      expect(await foreground()).toBe(before)
      expect(await windowsOnMyDesktop(await fixturePids(udd))).toBe(0)

      expect(((await h.m.run('s-e2e-3', 'await close()')).body as { error?: unknown }).error).toBeUndefined()
      await h.m.dispose()
      expect(await fixturePids(udd)).toEqual([])
    },
    120_000
  )

  it(
    'ends the app still on the desktop when its helper dies',
    async () => {
      const base = await tempDir()
      const profile = path.join(base, 'profile-2')
      const udd = path.join(base, 'electron-profile-2')
      udds.push(udd)
      const h = await harness(profile)
      managers.push(h.m)
      const before = await foreground()

      const first = await h.m.run('s-e2e-2', `log(await launch({ command: ${JSON.stringify(commandFor(udd))} }))`)
      expect((first.body as { error?: unknown }).error).toBeUndefined()
      await vi.waitFor(async () => expect(await recordedPids(h.recordFile)).toHaveLength(2))
      const pids = await recordedPids(h.recordFile)
      expect((await fixturePids(udd)).length).toBeGreaterThan(0)

      // The helper alone, not its tree: TerminateProcess on the one pid, as a crash would.
      process.kill(h.helpers[0].pid)
      await vi.waitFor(() => expect(h.helpers[0].alive()).toBe(false), { timeout: 10_000 })
      // The manager's exit handler ends the launched tree by pid and start time.
      await vi.waitFor(async () => expect(await fixturePids(udd)).toEqual([]), { timeout: 20_000, interval: 500 })
      expect((await processStartTimes(pids)).size).toBe(0)
      await vi.waitFor(async () => expect(await exists(h.recordFile)).toBe(false))
      expect(h.events.filter((e) => e.kind === 'state').at(-1)).toMatchObject({ open: false })
      expect(h.m.list()).toEqual([])
      expect(await foreground()).toBe(before)
      await h.m.dispose()
    },
    120_000
  )
})
