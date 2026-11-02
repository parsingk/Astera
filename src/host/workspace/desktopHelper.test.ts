import { describe, it, expect, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NOT_INTERACTIVE } from '../../core/workspace/lifecycle'
import { spawnPowerShell, startDesktopHelper, writeDeskScript, type DeskProcess } from './desktopHelper'
import { DESK_PS1 } from './desk'
import { killTree } from './native'

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (ok()) return true
  return ok()
}

/** A helper process the test answers by hand. `sent` is every request line, parsed. */
class FakeProc implements DeskProcess {
  pid = 4242
  sent: Array<Record<string, unknown>> = []
  killed = false
  /** A real process that is killed exits; false leaves the exit to the test (preflight ruling F2). */
  exitOnKill = true
  private lines: Array<(l: string) => void> = []
  private exits: Array<(why: string) => void> = []
  private dead = false
  /** Answers each request as it arrives; null leaves it pending. */
  answer: (req: Record<string, unknown>) => unknown = (req) => ({ id: req.id, ok: true, value: req.op === 'launch' ? { pid: 77, startedAt: 5 } : {} })
  write(line: string): void {
    const req = JSON.parse(line) as Record<string, unknown>
    this.sent.push(req)
    const a = this.answer(req)
    if (a !== null) queueMicrotask(() => this.say(typeof a === 'string' ? a : JSON.stringify(a)))
  }
  onLine(cb: (l: string) => void): void {
    this.lines.push(cb)
  }
  onExit(cb: (why: string) => void): void {
    this.exits.push(cb)
  }
  kill(): void {
    this.killed = true
    if (this.exitOnKill) queueMicrotask(() => this.die('killed'))
  }
  say(line: string): void {
    for (const cb of this.lines) cb(line)
  }
  die(why: string): void {
    if (this.dead) return
    this.dead = true
    for (const cb of this.exits) cb(why)
  }
  ready(interactive = true): void {
    this.say(JSON.stringify({ ready: true, interactive, pid: 4242, startedAt: 1_000 }))
  }
}

const started = async (proc: FakeProc, logs: string[] = []) => {
  const p = startDesktopHelper({ name: 'astera-ws-1-1', spawn: () => proc, log: (m) => logs.push(m) })
  proc.ready()
  return p
}

describe('startDesktopHelper', () => {
  it('waits for ready, creates the desktop by name, and reports its own pid and start time', async () => {
    const proc = new FakeProc()
    const h = await started(proc)
    expect(proc.sent[0]).toEqual({ op: 'create', name: 'astera-ws-1-1', id: 1 })
    expect(h.name).toBe('astera-ws-1-1')
    expect(h.pid).toBe(4242)
    expect(h.startedAt).toBe(1_000)
    expect(h.alive()).toBe(true)
  })

  it('an Add-Type failure fails the start with its message and ends the process', async () => {
    const proc = new FakeProc()
    const p = startDesktopHelper({ name: 'n', spawn: () => proc, log: () => {} })
    proc.say('{"fatal":"Add-Type failed: CS0246"}')
    await expect(p).rejects.toThrow('the desktop helper could not start: Add-Type failed: CS0246')
    expect(proc.killed).toBe(true)
  })

  it('no ready within the deadline fails the start and ends the process', async () => {
    const proc = new FakeProc()
    const p = startDesktopHelper({ name: 'n', spawn: () => proc, readyMs: 20, log: () => {} })
    await expect(p).rejects.toThrow('did not say ready within')
    expect(proc.killed).toBe(true)
  })

  it('a helper that is not on an interactive window station is refused', async () => {
    const proc = new FakeProc()
    const p = startDesktopHelper({ name: 'n', spawn: () => proc, log: () => {} })
    proc.ready(false)
    await expect(p).rejects.toThrow(NOT_INTERACTIVE)
    expect(proc.killed).toBe(true)
  })

  it('ignores noise, a BOM and CRLF around real lines (Review Focus 2)', async () => {
    const proc = new FakeProc()
    const logs: string[] = []
    const p = startDesktopHelper({ name: 'n', spawn: () => proc, log: (m) => logs.push(m) })
    proc.say('WARNING: The names of some imported commands include unapproved verbs.')
    proc.say('')
    proc.say(`${String.fromCharCode(0xfeff)}${JSON.stringify({ ready: true, interactive: true, pid: 1, startedAt: 2 })}\r`)
    const h = await p
    proc.answer = (req) => (req.op === 'windows' ? null : { id: req.id, ok: true, value: {} })
    const listed = h.windows()
    await new Promise((r) => setTimeout(r, 0))
    proc.say('some stray text')
    proc.say(`{"id":${String(proc.sent.at(-1)!.id)},"ok":true,"value":{"hwnd":5,"title":"T","className":"C","pid":9,"width":1,"height":1,"visible":true}}\r`)
    expect(await listed).toEqual([{ hwnd: 5, title: 'T', className: 'C', pid: 9, width: 1, height: 1, visible: true }])
    expect(logs.some((l) => l.includes('WARNING'))).toBe(true)
  })

  it('a cwd and env with spaces and Hangul arrive byte for byte (Review Focus 3)', async () => {
    const proc = new FakeProc()
    const h = await started(proc)
    const cwd = 'C:\\Users\\홍 길동\\내 앱'
    expect(await h.launch({ command: 'npm run dev', cwd, env: { NOTE: '가 나 다', PATH: 'C:\\Program Files\\nodejs' } })).toEqual({ pid: 77, startedAt: 5 })
    const req = proc.sent.find((r) => r.op === 'launch')!
    expect(req.cwd).toBe(cwd)
    expect(req.env).toEqual({ NOTE: '가 나 다', PATH: 'C:\\Program Files\\nodejs' })
    expect(req.commandLine).toBe('cmd.exe /s /c "npm run dev"')
  })

  it('serialises requests: the second is written only after the first is answered', async () => {
    const proc = new FakeProc()
    const h = await started(proc)
    proc.answer = () => null
    const a = h.windows()
    const b = h.keys({ title: 'T', key: 'Enter' })
    await new Promise((r) => setTimeout(r, 0))
    expect(proc.sent.map((r) => r.op)).toEqual(['create', 'windows'])
    proc.say(JSON.stringify({ id: 2, ok: true, value: [] }))
    await a
    await new Promise((r) => setTimeout(r, 0))
    expect(proc.sent.map((r) => r.op)).toEqual(['create', 'windows', 'keys'])
    expect(proc.sent[2]).toMatchObject({ title: 'T', key: 'Enter', text: null })
    proc.say(JSON.stringify({ id: 3, ok: true, value: {} }))
    await b
  })

  it('a failed reply rejects with the helper own words', async () => {
    const proc = new FakeProc()
    const h = await started(proc)
    proc.answer = (req) => ({ id: req.id, ok: false, error: 'no window titled "Save" is showing on this desktop' })
    await expect(h.shot({ title: 'Save', format: 'png' })).rejects.toThrow('no window titled "Save"')
  })

  it('when the process dies every pending call rejects, later calls reject at once, and listeners hear it', async () => {
    const proc = new FakeProc()
    const h = await started(proc)
    const heard = vi.fn()
    h.onExit(heard)
    proc.answer = () => null
    const pending = h.windows()
    await new Promise((r) => setTimeout(r, 0))
    proc.die('exited 1')
    await expect(pending).rejects.toThrow('the desktop helper ended (exited 1)')
    await expect(h.windows()).rejects.toThrow('the desktop helper ended (exited 1)')
    expect(heard).toHaveBeenCalledWith('exited 1')
    expect(h.alive()).toBe(false)
  })

  it('close asks the helper to close the desktop, then ends the process', async () => {
    const proc = new FakeProc()
    const h = await started(proc)
    await h.close()
    expect(proc.sent.at(-1)?.op).toBe('close')
    expect(proc.killed).toBe(true)
  })

  it('close resolves only once the helper process has exited (preflight ruling F2)', async () => {
    const proc = new FakeProc()
    proc.exitOnKill = false
    const h = await started(proc)
    let done = false
    const closing = h.close().then(() => {
      done = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(proc.sent.at(-1)?.op).toBe('close')
    expect(done).toBe(false)
    expect(h.alive()).toBe(true)
    proc.die('exited 0')
    await closing
    expect(h.alive()).toBe(false)
  })

  it('close stops waiting for an exit after 5 s and says so (preflight ruling F2)', async () => {
    vi.useFakeTimers()
    try {
      const proc = new FakeProc()
      proc.exitOnKill = false
      const logs: string[] = []
      const h = await started(proc, logs)
      let done = false
      const closing = h.close().then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(4_900)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      await closing
      expect(proc.killed).toBe(true)
      expect(logs.some((l) => l.includes('did not exit within 5 s'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('close has one 5 s deadline for the close request and the exit together (preflight ruling F2)', async () => {
    vi.useFakeTimers()
    try {
      const proc = new FakeProc()
      proc.exitOnKill = false
      const logs: string[] = []
      const h = await started(proc, logs)
      proc.answer = () => null
      let done = false
      const closing = h.close().then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(4_900)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      await closing
      expect(proc.killed).toBe(true)
      expect(logs.some((l) => l.includes('did not exit within 5 s'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('kill sends the pid with its launch start time, and logs when the helper skipped a reused pid', async () => {
    const proc = new FakeProc()
    const logs: string[] = []
    const h = await started(proc, logs)
    await h.kill(77, 5)
    expect(proc.sent.at(-1)).toEqual({ op: 'kill', pid: 77, startedAt: 5, id: 2 })
    expect(logs).toEqual([])
    proc.answer = (req) => ({ id: req.id, ok: true, value: { killed: false, reason: 'start time mismatch: pid 77 started at 9000, not 5' } })
    await expect(h.kill(77, 5)).resolves.toBeUndefined()
    expect(logs.some((l) => l.includes('did not kill pid 77') && l.includes('start time mismatch'))).toBe(true)
  })

  it('logs a launch the helper could not put in a job, with the reason, and still answers it', async () => {
    const proc = new FakeProc()
    const logs: string[] = []
    const h = await started(proc, logs)
    await h.launch({ command: 'npm run dev', cwd: 'C:\\app', env: {} })
    expect(logs).toEqual([])
    proc.answer = (req) => ({ id: req.id, ok: true, value: { pid: 78, startedAt: 6, job: false, jobError: 'AssignProcessToJobObject failed: 5' } })
    expect(await h.launch({ command: 'npm run dev', cwd: 'C:\\app', env: {} })).toEqual({ pid: 78, startedAt: 6 })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('pid 78')
    expect(logs[0]).toContain('without a job object (AssignProcessToJobObject failed: 5)')
  })

  it('a request unanswered for 15 s rejects, ends the helper, and every later request rejects at once', async () => {
    vi.useFakeTimers()
    try {
      const proc = new FakeProc()
      proc.exitOnKill = false
      const h = await started(proc)
      proc.answer = () => null
      const heard = vi.fn()
      h.onExit(heard)
      const hung = h.windows()
      const queued = h.keys({ title: 'T', key: 'Enter' })
      const hungDone = expect(hung).rejects.toThrow('the desktop helper did not answer windows within 15 s')
      const queuedDone = expect(queued).rejects.toThrow('the desktop helper ended')
      await vi.advanceTimersByTimeAsync(14_900)
      expect(proc.killed).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      await hungDone
      await queuedDone
      expect(proc.killed).toBe(true)
      expect(h.alive()).toBe(false)
      expect(proc.sent.map((r) => r.op)).toEqual(['create', 'windows'])
      await expect(h.windows()).rejects.toThrow('the desktop helper ended')
      proc.die('killed')
      expect(heard).toHaveBeenCalledWith('killed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('close on a helper that already ended resolves at once and writes nothing', async () => {
    const proc = new FakeProc()
    const h = await started(proc)
    proc.die('exited 1')
    const before = proc.sent.length
    await h.close()
    expect(proc.sent.length).toBe(before)
  })
})

describe('writeDeskScript', () => {
  it('writes the script once under a content name and leaves an identical file alone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-desk-'))
    try {
      const file = await writeDeskScript(dir)
      expect(path.basename(file)).toMatch(/^desk-[0-9a-f]{8}\.ps1$/)
      expect(await fs.readFile(file, 'utf8')).toBe(DESK_PS1)
      const before = (await fs.stat(file)).mtimeMs
      await new Promise((r) => setTimeout(r, 20))
      expect(await writeDeskScript(dir)).toBe(file)
      expect((await fs.stat(file)).mtimeMs).toBe(before)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// The one place the C# is compiled before Task 10: a helper that compiles says ready. Creating a
// desktop object takes nothing from anyone (nobody switches to it), and a CI session that is not
// interactive answers NOT_INTERACTIVE, which skips the test here with its reason: what must not happen is
// an Add-Type failure.
const NO_DESKTOP = 'no interactive desktop in this session, so the helper cannot make a desktop'

describe('the real helper', () => {
  it.runIf(process.platform === 'win32')(
    'compiles, says ready, and creates and closes a desktop',
    async (ctx) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-desk-live-'))
      try {
        const file = await writeDeskScript(dir)
        let h: Awaited<ReturnType<typeof startDesktopHelper>> | null = null
        try {
          h = await startDesktopHelper({ name: `astera-test-${process.pid}`, spawn: () => spawnPowerShell(file), readyMs: 30_000, log: () => {} })
        } catch (err) {
          expect(String(err)).toContain('no interactive desktop')
          return ctx.skip(NO_DESKTOP)
        }
        expect(Array.isArray(await h.windows())).toBe(true)
        // The kill guard, for real: a start time that does not match leaves the process alone.
        const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))
        const l = await h.launch({ command: 'ping -n 60 127.0.0.1', cwd: os.tmpdir(), env })
        try {
          expect(isAlive(l.pid)).toBe(true)
          await h.kill(l.pid, l.startedAt + 10_000)
          await new Promise((r) => setTimeout(r, 300))
          expect(isAlive(l.pid)).toBe(true)
          await h.kill(l.pid, l.startedAt)
          expect(await until(() => !isAlive(l.pid), 5_000)).toBe(true)
        } finally {
          if (isAlive(l.pid)) await killTree(l.pid)
        }
        await h.close()
        expect(h.alive()).toBe(false)
      } finally {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    60_000
  )

  // What taskkill /T cannot reach: a detached child whose parent has already exited, so no parent pid
  // leads to it from the launched process. cmd runs the parent, which starts the child detached (the
  // way a dev Astera starts its Host), writes its pid and exits; then cmd stays on ping, so the
  // launched process itself is alive and passes the start time check.
  const orphanTree = async (dir: string): Promise<{ command: string; orphan: () => Promise<number> }> => {
    const script = path.join(dir, 'orphan.cjs')
    const pidFile = path.join(dir, 'orphan.pid')
    await fs.writeFile(
      script,
      [
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
        "require('node:fs').writeFileSync(process.argv[2], String(c.pid))",
        'c.unref()',
        ''
      ].join('\n'),
      'utf8'
    )
    return {
      command: `"${process.execPath}" "${script}" "${pidFile}" & ping -n 60 127.0.0.1`,
      orphan: async () => {
        let pid = 0
        await until(() => {
          try {
            pid = Number(readFileSync(pidFile, 'utf8')) || 0
          } catch {
            /* not written yet */
          }
          return pid > 0
        }, 10_000)
        return pid
      }
    }
  }

  const liveHelper = async (dir: string, logs: string[]): Promise<Awaited<ReturnType<typeof startDesktopHelper>> | null> => {
    const file = await writeDeskScript(dir)
    try {
      return await startDesktopHelper({ name: `astera-test-${process.pid}-${Date.now()}`, spawn: () => spawnPowerShell(file), readyMs: 30_000, log: (m) => logs.push(m) })
    } catch (err) {
      expect(String(err)).toContain('no interactive desktop')
      return null
    }
  }

  const env = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))

  it.runIf(process.platform === 'win32')(
    'kill ends the launch through its job: a detached child whose parent already exited goes too',
    async (ctx) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-desk-job-'))
      const logs: string[] = []
      const left: number[] = []
      try {
        const h = await liveHelper(dir, logs)
        if (!h) return ctx.skip(NO_DESKTOP)
        const tree = await orphanTree(dir)
        const l = await h.launch({ command: tree.command, cwd: dir, env: env() })
        left.push(l.pid)
        const orphan = await tree.orphan()
        left.push(orphan)
        expect(orphan).toBeGreaterThan(0)
        expect(isAlive(orphan)).toBe(true)
        await h.kill(l.pid, l.startedAt)
        expect(await until(() => !isAlive(l.pid) && !isAlive(orphan), 5_000)).toBe(true)
        expect(logs.filter((m) => m.includes('without a job object'))).toEqual([])
        await h.close()
      } finally {
        for (const pid of left) if (isAlive(pid)) await killTree(pid)
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    60_000
  )

  it.runIf(process.platform === 'win32')(
    'kill ends the job after the launched command exited at once, leaving a detached child behind',
    async (ctx) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-desk-jobgone-'))
      const logs: string[] = []
      const left: number[] = []
      try {
        const h = await liveHelper(dir, logs)
        if (!h) return ctx.skip(NO_DESKTOP)
        // No ping after the parent: the launched process is gone and only the job still holds the child.
        const tree = await orphanTree(dir)
        const l = await h.launch({ command: tree.command.replace(' & ping -n 60 127.0.0.1', ''), cwd: dir, env: env() })
        left.push(l.pid)
        const orphan = await tree.orphan()
        left.push(orphan)
        expect(orphan).toBeGreaterThan(0)
        expect(await until(() => !isAlive(l.pid), 10_000)).toBe(true)
        expect(isAlive(orphan)).toBe(true)
        await h.kill(l.pid, l.startedAt)
        expect(await until(() => !isAlive(orphan), 5_000)).toBe(true)
        expect(logs.filter((m) => m.includes('without a job object'))).toEqual([])
        await h.close()
      } finally {
        for (const pid of left) if (isAlive(pid)) await killTree(pid)
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    60_000
  )

  it.runIf(process.platform === 'win32')(
    'a helper that exits takes its launch with it, the detached orphan included (KILL_ON_JOB_CLOSE)',
    async (ctx) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-desk-jobclose-'))
      const logs: string[] = []
      const left: number[] = []
      try {
        const h = await liveHelper(dir, logs)
        if (!h) return ctx.skip(NO_DESKTOP)
        const tree = await orphanTree(dir)
        const l = await h.launch({ command: tree.command, cwd: dir, env: env() })
        left.push(l.pid)
        const orphan = await tree.orphan()
        left.push(orphan)
        expect(isAlive(orphan)).toBe(true)
        // The helper alone, as a crash would end it: no kill and no close request first.
        process.kill(h.pid)
        expect(await until(() => !h.alive(), 10_000)).toBe(true)
        expect(await until(() => !isAlive(l.pid) && !isAlive(orphan), 5_000)).toBe(true)
      } finally {
        for (const pid of left) if (isAlive(pid)) await killTree(pid)
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    60_000
  )
})

describe('spawnPowerShell', () => {
  it.runIf(process.platform === 'win32')(
    'reads every byte the process wrote before it reports the exit, a last line with no newline included',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-desk-drain-'))
      try {
        const file = path.join(dir, 'drain.ps1')
        const script = ["[Console]::Out.Write(('x' * 3000000) + [char]10)", "[Console]::Out.Write('tail-without-newline')", '[Console]::Out.Flush()', 'exit 0', ''].join('\n')
        await fs.writeFile(file, script, 'utf8')
        const proc = spawnPowerShell(file)
        const lines: string[] = []
        proc.onLine((l) => lines.push(l))
        const seen = await new Promise<string[]>((resolve) => proc.onExit(() => resolve([...lines])))
        expect(seen.map((l) => l.length)).toEqual([3_000_000, 'tail-without-newline'.length])
        expect(seen[1]).toBe('tail-without-newline')
      } finally {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    60_000
  )
})
