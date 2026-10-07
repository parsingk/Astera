// The agent app workspace on a real macOS session (Linux and macOS design, Testing): the fixture
// launched in the background, driven over CDP only. Gated twice: darwin and ASTERA_DESKTOP_E2E=1,
// because it launches Electron in the person's session. CI runs it on the macos job. It checks the CDP
// helpers, a drag, a file drop and a page capture on a window that is never shown (R5: the fixture
// reads the hide marker ASTERA_APP_CHROMIUM_FLAGS), the three refusals (windows, windowShot, keys),
// and that nothing is left once the workspace is closed.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostWorkerBaseEnv } from '../../core/host/spawn'
import { connectCdp } from './cdp'
import { macRefusal } from './deskMac'
import { electronExe, exists, read2 } from './e2eSupport'
import { createLaunchResolver } from './launch'
import { createWorkspaceManager, type WorkspaceEvent, type WorkspaceManager } from './manager'
import { freePort, killTree, processStartTimes } from './native'
import { workspaceDeskStarter } from './platformDesk'
import { execText } from './posixProc'

const here = path.dirname(fileURLToPath(import.meta.url))
const enabled = process.platform === 'darwin' && process.env.ASTERA_DESKTOP_E2E === '1'
const TITLE = 'Astera workspace fixture'

// A plain command, not a bundle: the desk runs it through `sh -c` with the hide marker in its env, and
// the command passes the marker's Chromium switches on, as a project's own command would.
const commandFor = (udd: string): string =>
  `"${electronExe()}" "${path.join(here, 'fixtures', 'app', 'main.cjs')}" --remote-debugging-port=$ASTERA_APP_CDP_PORT --user-data-dir="${udd}" $ASTERA_APP_CHROMIUM_FLAGS`

/** Pids whose command line holds this user data folder. `-ww`: without a tty ps cuts its columns
 *  short, and the folder sits far along an Electron command line. */
const fixturePids = async (udd: string): Promise<number[]> =>
  (await execText('ps', ['-ww', '-Ao', 'pid=,command=']))
    .split('\n')
    .filter((l) => l.includes(udd))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isSafeInteger(n) && n > 0)

describe.runIf(enabled)('the agent app workspace on a real macOS session', () => {
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

  it(
    'launches in the background, drives the page, refuses the native helpers, and leaves nothing',
    async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-맥 e2e-'))
      const profile = path.join(dir, 'profile')
      await fs.mkdir(profile, { recursive: true })
      const udd = path.join(dir, 'electron-profile')
      udds.push(udd)
      const dropped = path.join(dir, 'drop me.txt')
      await fs.writeFile(dropped, 'x', 'utf8')
      const events: WorkspaceEvent[] = []
      const log: string[] = []
      const recordFile = path.join(profile, 'orch', 'workspaces.json')
      const m = createWorkspaceManager({
        platform: process.platform,
        env: process.env,
        recordFile,
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
        startDesk: workspaceDeskStarter({ platform: 'darwin', profileDir: profile, hostEnv: process.env, log: (x) => log.push(x) }),
        connectCdp: (port, waitMs) => connectCdp(port, waitMs),
        freePort,
        killTree: (pid) => killTree(pid),
        startTimes: (pids) => processStartTimes(pids),
        emit: (e) => events.push(e),
        hasWatchers: () => true,
        log: (x) => log.push(x)
      })
      managers.push(m)

      // 1. Launch in the background, and look.
      const first = await m.run('s-mac', `log(await launch({ command: ${JSON.stringify(commandFor(udd))} })); log((await snapshot()).title)`)
      expect(first.status).toBe(200)
      const firstBody = first.body as { log: string[]; error?: unknown }
      expect(firstBody.error).toBeUndefined()
      expect(firstBody.log[1]).toBe(TITLE)
      expect((await fixturePids(udd)).length).toBeGreaterThan(0)
      // The record is written after the launch, serialised behind any earlier write: waited for. A desk
      // with no helper process records only the app (R7).
      await vi.waitFor(async () => {
        const record = JSON.parse(await fs.readFile(recordFile, 'utf8')) as { workspaces: Array<{ desktop: string; pids: unknown[] }> }
        expect(record.workspaces[0].desktop).toMatch(/^mac-bg-/)
        expect(record.workspaces[0].pids).toHaveLength(1)
      })
      const port = (JSON.parse(firstBody.log[0]) as { port: number }).port

      // 2. Drive the page, capture it, and meet the three refusals.
      const second = await m.run(
        's-mac',
        [
          "await click('#b')",
          "await drag('#src', '#dst')",
          `await dropFiles('#drop', [${JSON.stringify(dropped)}])`,
          'log(await screenshot())',
          `for (const call of [() => windows(), () => windowShot(), () => keys(${JSON.stringify(TITLE)}, 'y')]) {`,
          "  try { await call(); log('no refusal') } catch (e) { log(e.message) }",
          '}'
        ].join('\n')
      )
      const body = second.body as { log: string[]; error?: unknown }
      expect(body.error).toBeUndefined()
      const shot = JSON.parse(body.log[0]) as { path: string; width: number }
      expect(shot.width).toBeGreaterThan(100)
      expect((await fs.stat(shot.path)).size).toBeGreaterThan(1000)
      expect(body.log.slice(1)).toEqual([macRefusal('windows'), macRefusal('windowShot'), macRefusal('keys')])
      expect(await read2(port, "document.getElementById('out').textContent")).toBe('clicked')
      const recorded = JSON.parse(String(await read2(port, 'JSON.stringify(window.events)'))) as Array<Record<string, unknown>>
      expect(recorded).toEqual(expect.arrayContaining([{ kind: 'drop', text: 'card-1' }, { kind: 'files', names: ['drop me.txt'] }]))
      expect(events.some((e) => e.kind === 'frame')).toBe(true)

      // 3. Close, and nothing is left.
      expect(((await m.run('s-mac', 'await close()')).body as { error?: unknown }).error).toBeUndefined()
      await m.dispose()
      await vi.waitFor(async () => expect(await fixturePids(udd)).toEqual([]), { timeout: 10_000, interval: 250 })
      expect(await exists(recordFile)).toBe(false)
      expect(events.filter((e) => e.kind === 'state').at(-1)).toMatchObject({ open: false })
    },
    180_000
  )
})
