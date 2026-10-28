import { promises as fs } from 'node:fs'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  UNKNOWN_KEEP_MS,
  WINDOWS_OWNER_SETUP,
  linuxOwnerReader,
  macOwnerReader,
  powerShellHelperCommand,
  rolloutOwnerCheck,
  rolloutOwnerReader,
  windowsOwnerReader,
  type OwnerHelper,
  type ProcFs,
  type RolloutOwnership,
  type RunTool
} from './rolloutOwner'

const FILE = '/home/u/.codex/sessions/2026/10/28/rollout-2026-10-28T10-00-00-019f.jsonl'

const fail = (code: string): Error => Object.assign(new Error(code), { code })

/** A /proc with `procs` (pid → ppid and the paths its fds point at). `denied` names reads that fail with a code other
 *  than "gone": `stat:<pid>`, `fd:<pid>`, `link:<pid>`. */
const procFs = (
  procs: Record<number, { ppid: number; fds?: string[] }>,
  o: { noProc?: boolean; denied?: Record<string, string> } = {}
): ProcFs => {
  const denied = (what: string): void => {
    const code = o.denied?.[what]
    if (code) throw fail(code)
  }
  return {
    readdir: async (p) => {
      if (p === '/proc') {
        if (o.noProc) throw fail('ENOENT')
        return [...Object.keys(procs), ...Object.keys(o.denied ?? {}).filter((k) => k.startsWith('stat:')).map((k) => k.slice(5)), 'self', 'stat']
      }
      const m = /^\/proc\/(\d+)\/fd$/.exec(p)
      if (m) denied(`fd:${m[1]}`)
      const proc = m ? procs[Number(m[1])] : undefined
      if (!proc) throw fail('ENOENT')
      return (proc.fds ?? []).map((_, i) => String(i))
    },
    readFile: async (p) => {
      const m = /^\/proc\/(\d+)\/stat$/.exec(p)
      if (m) denied(`stat:${m[1]}`)
      const proc = m ? procs[Number(m[1])] : undefined
      if (!proc) throw fail('ENOENT')
      // The command name may hold spaces and parentheses: fields are counted from the last ')'
      return `${m![1]} (co dex) (x) S ${proc.ppid} 1 1 0 -1 4194304`
    },
    readlink: async (p) => {
      const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(p)
      if (m) denied(`link:${m[1]}`)
      const fd = m ? procs[Number(m[1])]?.fds?.[Number(m[2])] : undefined
      if (fd === undefined) throw fail('ENOENT')
      return fd
    },
    realpath: async (p) => p
  }
}

describe('linuxOwnerReader', () => {
  it('says own when a process under the session holds the file open', async () => {
    // 100 is the pty's process (the npm shim), 101 the native codex it started
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 100: { ppid: 1 }, 101: { ppid: 100, fds: ['/dev/pts/3', FILE] } }))
    expect(await read(FILE, 100)).toEqual({ verdict: 'own' })
  })

  it('says other when no process of the session holds it', async () => {
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 100: { ppid: 1, fds: ['/dev/pts/3'] }, 200: { ppid: 1, fds: [FILE] } }))
    expect((await read(FILE, 100)).verdict).toBe('other')
  })

  // A process that ended between the listing and the read is gone, not unreadable
  it('passes over a process of the session that ended meanwhile', async () => {
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 100: { ppid: 1, fds: ['/dev/pts/3'] }, 101: { ppid: 100 } }, { denied: { 'fd:101': 'ESRCH' } }))
    expect((await read(FILE, 100)).verdict).toBe('other')
  })

  // Review Important 1: a read that fails is "cannot tell", never "held by another process"
  it('cannot tell when an fd folder of the session cannot be read', async () => {
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 100: { ppid: 1 }, 101: { ppid: 100, fds: [FILE] } }, { denied: { 'fd:101': 'EACCES' } }))
    const r = await read(FILE, 100)
    expect(r.verdict).toBe('unknown')
  })

  it('cannot tell when an fd of the session cannot be read', async () => {
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 100: { ppid: 1, fds: [FILE] } }, { denied: { 'link:100': 'EPERM' } }))
    expect((await read(FILE, 100)).verdict).toBe('unknown')
  })

  it('cannot tell when the session process cannot be read', async () => {
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 100: { ppid: 1, fds: [FILE] } }, { denied: { 'stat:100': 'EACCES' } }))
    expect((await read(FILE, 100)).verdict).toBe('unknown')
  })

  // A process whose parent cannot be read may be one under the session, so its absence proves nothing
  it('cannot tell when another process cannot be read and nothing of the session holds the file', async () => {
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 100: { ppid: 1 } }, { denied: { 'stat:150': 'EMFILE' } }))
    expect((await read(FILE, 100)).verdict).toBe('unknown')
  })

  it('cannot tell when the session process is gone', async () => {
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 200: { ppid: 1, fds: [FILE] } }))
    expect((await read(FILE, 100)).verdict).toBe('unknown')
  })

  it('cannot tell when /proc cannot be read', async () => {
    const read = linuxOwnerReader(procFs({}, { noProc: true }))
    expect((await read(FILE, 100)).verdict).toBe('unknown')
  })

  // One open file per process at once would run out of descriptors on a busy machine
  it('reads the processes a few at a time', async () => {
    const procs: Record<number, { ppid: number; fds?: string[] }> = { 1: { ppid: 0 } }
    for (let p = 2; p < 300; p++) procs[p] = { ppid: 1 }
    const base = procFs(procs)
    let open = 0
    let most = 0
    const read = linuxOwnerReader({
      ...base,
      readFile: async (p) => {
        open++
        most = Math.max(most, open)
        await new Promise((r) => setTimeout(r, 1))
        open--
        return base.readFile(p)
      }
    })
    await read(FILE, 2)
    expect(most).toBeLessThanOrEqual(32)
  })
})

type Out = { code: number; stdout: string; stderr?: string }

/** A run that answers `lsof` and `ps` from tables, or throws for a tool that is missing. */
const tools = (t: { lsof?: Out | 'missing'; ps?: string }): { run: RunTool; calls: string[][] } => {
  const calls: string[][] = []
  const run: RunTool = async (file, args) => {
    calls.push([file, ...args])
    if (file.endsWith('lsof')) {
      if (t.lsof === 'missing' || t.lsof === undefined) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
      return { stderr: '', ...t.lsof }
    }
    if (file.endsWith('ps')) return { code: 0, stdout: t.ps ?? '', stderr: '' }
    throw new Error(`unexpected tool ${file}`)
  }
  return { run, calls }
}

describe('macOwnerReader', () => {
  const ps = '    1     0\n  300     1\n  301   300\n  400     1\n'

  it('says own when lsof names a process under the session', async () => {
    const t = tools({ lsof: { code: 0, stdout: '301\n' }, ps })
    expect(await macOwnerReader(t.run)(FILE, 300)).toEqual({ verdict: 'own' })
    // The file goes after `--`, so a name that starts with a dash is never read as an option
    expect(t.calls[0]).toEqual(['/usr/sbin/lsof', '-w', '-t', '--', FILE])
  })

  it('says other when lsof names only processes outside the session', async () => {
    const r = await macOwnerReader(tools({ lsof: { code: 0, stdout: '400\n' }, ps }).run)(FILE, 300)
    expect(r).toEqual({ verdict: 'other', why: 'held by pid 400 outside the session' })
  })

  it('says other when no process holds it (lsof exits 1 and prints nothing)', async () => {
    const r = await macOwnerReader(tools({ lsof: { code: 1, stdout: '' }, ps }).run)(FILE, 300)
    expect(r.verdict).toBe('other')
  })

  // Review Important 1: lsof exits 1 on an error too, and says why on stderr
  it('cannot tell when lsof exits 1 with an error', async () => {
    const r = await macOwnerReader(tools({ lsof: { code: 1, stdout: '', stderr: 'lsof: status error on /x: Permission denied\n' }, ps }).run)(FILE, 300)
    expect(r.verdict).toBe('unknown')
  })

  it('cannot tell when lsof names only outside processes but also failed somewhere', async () => {
    const r = await macOwnerReader(tools({ lsof: { code: 1, stdout: '400\n', stderr: 'lsof: WARNING: can not stat\n' }, ps }).run)(FILE, 300)
    expect(r.verdict).toBe('unknown')
  })

  it('cannot tell when lsof is missing', async () => {
    const r = await macOwnerReader(tools({ lsof: 'missing', ps }).run)(FILE, 300)
    expect(r.verdict).toBe('unknown')
  })
})

/** A PowerShell helper that answers each question with `answer(file, pid)` (a verdict line without its number), or
 *  leaves it unanswered for null. `setup` is what it prints once it has read its setup: `ready` or `unready|<why>`. */
class FakeHelper implements OwnerHelper {
  written: string[] = []
  ended = false
  killed = false
  private lines: Array<(line: string) => void> = []
  private ends: Array<(why: string) => void> = []
  constructor(
    private answer: (file: string, pid: number) => string | null,
    private setup = 'ready'
  ) {}
  write(text: string): void {
    this.written.push(text)
    if (this.written.length === 1) return queueMicrotask(() => this.say(this.setup))
    const m = /^try \{ '(\d+)\|' \+ \[AsteraRolloutOwner\]::Ask\('([A-Za-z0-9+/=]*)', (\d+)\) \}/.exec(text)
    if (!m) throw new Error(`not a question: ${text}`)
    const verdict = this.answer(Buffer.from(m[2], 'base64').toString('utf8'), Number(m[3]))
    if (verdict !== null) queueMicrotask(() => this.say(`${m[1]}|${verdict}`))
  }
  end(): void {
    this.ended = true
  }
  kill(): void {
    this.killed = true
    this.die('killed')
  }
  onLine(cb: (line: string) => void): void {
    this.lines.push(cb)
  }
  onEnd(cb: (why: string) => void): void {
    this.ends.push(cb)
  }
  say(line: string): void {
    for (const cb of this.lines) cb(line)
  }
  die(why: string): void {
    for (const cb of this.ends.splice(0)) cb(why)
  }
}

const helpers = (make: () => FakeHelper): { start: () => FakeHelper; started: FakeHelper[] } => {
  const started: FakeHelper[] = []
  return { started, start: () => (started.push(make()), started[started.length - 1]) }
}

describe('windowsOwnerReader', () => {
  // Review Minor 6 and re-review Minor 2: Windows PowerShell by its absolute path (a bare name is looked up in the working
  // directory first), reading its commands from stdin. No script file, so no -File for a Group Policy execution policy to
  // refuse, and no -ExecutionPolicy or -EncodedCommand, patterns security tools flag.
  it('starts Windows PowerShell by its absolute System32 path, reading commands from stdin', () => {
    const { file, args } = powerShellHelperCommand('C:\\Windows')
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-'])
  })

  // Review Minor 6: the C# was compiled again for every question, a PowerShell and a csc run each time
  it('compiles the helper once and asks every question of the same PowerShell', async () => {
    const h = helpers(() => new FakeHelper((file) => (file === 'C:\\a.jsonl' ? 'own|1234' : 'other|held by pid 97252 outside the session')))
    const read = windowsOwnerReader(h.start)
    expect(await read('C:\\a.jsonl', 1234)).toEqual({ verdict: 'own' })
    expect(await read('C:\\b.jsonl', 1234)).toEqual({ verdict: 'other', why: 'held by pid 97252 outside the session' })
    expect(h.started).toHaveLength(1)
    const [setup, ...questions] = h.started[0].written
    expect(setup).toBe(WINDOWS_OWNER_SETUP)
    expect(setup).toContain('Add-Type')
    expect(questions).toHaveLength(2)
    read.close()
  })

  // Each question is one line of PowerShell Astera writes: a number, the path as base64 and the pid as a number. Nothing
  // of the path reaches PowerShell as code, and a name in any script survives the console code page.
  it('passes the file as base64 of its UTF-8 and the pid as a number', async () => {
    const h = helpers(() => new FakeHelper(() => 'own|1'))
    const read = windowsOwnerReader(h.start)
    const file = "C:\\Users\\o'neil $(calc)\\한글\\.codex\\sessions\\rollout-x.jsonl"
    await read(file, 4100)
    const q = h.started[0].written[1]
    expect(q).toBe(
      `try { '0|' + [AsteraRolloutOwner]::Ask('${Buffer.from(file, 'utf8').toString('base64')}', 4100) } catch { '0|unknown|' + ($_.Exception.Message -replace '[\\r\\n|]', ' ') }\n`
    )
    read.close()
  })

  // Re-review Minor 2 and fix round 2: no script file anywhere, so nothing for a sandboxed session to replace either
  it('writes no file', async () => {
    const writes = vi.spyOn(fs, 'writeFile')
    const mkdirs = vi.spyOn(fs, 'mkdir')
    onTestFinished(() => {
      writes.mockRestore()
      mkdirs.mockRestore()
    })
    const read = windowsOwnerReader(helpers(() => new FakeHelper(() => 'own|1')).start)
    await read('C:\\x.jsonl', 1)
    expect(writes).not.toHaveBeenCalled()
    expect(mkdirs).not.toHaveBeenCalled()
    read.close()
  })

  // PowerShell reads its stdin in the console's code page
  it('keeps what it writes to ASCII', () => {
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(WINDOWS_OWNER_SETUP)).toBe(true)
    expect(WINDOWS_OWNER_SETUP).toContain('RmGetList')
  })

  // Read from stdin as typed at the prompt, the setup's statement over several lines runs only once an empty line
  // follows it: without one, Windows PowerShell 5.1 ran nothing and said nothing
  it('ends its setup with an empty line', () => {
    expect(WINDOWS_OWNER_SETUP.endsWith("' ') }\n\n")).toBe(true)
  })

  // Constrained Language Mode refuses Add-Type: said once, as unknown, and the next question tries a new PowerShell
  it('cannot tell when the helper cannot be compiled, and tries a new PowerShell for the next question', async () => {
    const h = helpers(() => new FakeHelper(() => null, 'unready|Cannot add type. Definition of new types is not supported in this language mode.'))
    const read = windowsOwnerReader(h.start)
    const r = await read('C:\\x.jsonl', 10)
    expect(r.verdict).toBe('unknown')
    expect(r.verdict === 'unknown' && r.why).toMatch(/language mode/)
    expect(h.started[0].killed).toBe(true)
    await read('C:\\x.jsonl', 10)
    expect(h.started).toHaveLength(2)
    read.close()
  })

  it('cannot tell when the helper ends or cannot start, for every question waiting on it', async () => {
    const h = helpers(() => new FakeHelper(() => null))
    const read = windowsOwnerReader(h.start)
    const a = read('C:\\a.jsonl', 10)
    const b = read('C:\\b.jsonl', 10)
    h.started[0].die('spawn powershell.exe ENOENT')
    expect((await a).verdict).toBe('unknown')
    expect((await b).verdict).toBe('unknown')
    read.close()
  })

  it('cannot tell when the helper does not answer in time, and ends it', async () => {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
    const h = helpers(() => new FakeHelper(() => null))
    const read = windowsOwnerReader(h.start, { answerMs: 20_000 })
    const r = read('C:\\x.jsonl', 10)
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await r).verdict).toBe('unknown')
    expect(h.started[0].killed).toBe(true)
    read.close()
  })

  // Kept only while questions come (a session's first minute): no PowerShell left running for the app's whole life
  it('ends the helper once it has been idle, and starts another for a later question', async () => {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
    const h = helpers(() => new FakeHelper(() => 'own|1'))
    const read = windowsOwnerReader(h.start, { idleMs: 120_000 })
    await read('C:\\x.jsonl', 1)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(h.started[0].ended).toBe(false)
    await read('C:\\y.jsonl', 1) // a question in time keeps it
    await vi.advanceTimersByTimeAsync(119_999)
    expect(h.started[0].ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.started[0].ended).toBe(true)
    await read('C:\\z.jsonl', 1)
    expect(h.started).toHaveLength(2)
    read.close()
  })

  // Review Important 1, the Windows half, is in the script: a process OpenProcess cannot open is "cannot tell" unless
  // it is gone (ERROR_INVALID_PARAMETER), and a walk that stops on one answers unknown when nothing resolved to own.
  it('says in the script that a process it cannot open is cannot-tell, and only error 87 is gone', () => {
    expect(WINDOWS_OWNER_SETUP).toContain('87')
    expect(WINDOWS_OWNER_SETUP).toMatch(/unknown\|/)
  })

  it('never asks about a pid that is not a whole number a process can have', async () => {
    const h = helpers(() => new FakeHelper(() => 'own|1'))
    const read = windowsOwnerReader(h.start)
    expect((await read('C:\\x.jsonl', 1.5)).verdict).toBe('unknown')
    expect((await read('C:\\x.jsonl', 2 ** 31)).verdict).toBe('unknown')
    expect(h.started).toHaveLength(0)
  })
})

describe('rolloutOwnerCheck', () => {
  it('asks once per candidate and session process, and says why it skips one, without the file contents', async () => {
    let reads = 0
    const logs: string[] = []
    const check = rolloutOwnerCheck({
      read: async (): Promise<RolloutOwnership> => {
        reads++
        return { verdict: 'other', why: 'held by pid 97252 outside the session' }
      },
      log: (m) => logs.push(m)
    })
    await check('C:\\a.jsonl', 10, 'ses_1')
    await check('C:\\a.jsonl', 10, 'ses_1')
    expect(reads).toBe(1)
    expect(logs).toEqual(['codex rollout skipped for session=ses_1: C:\\a.jsonl (held by pid 97252 outside the session)'])
    // Another session process is another question
    await check('C:\\a.jsonl', 11, 'ses_2')
    expect(reads).toBe(2)
  })

  // Review Important 1: "cannot tell" is not remembered, and is said once per session
  // Fix round 3 (re-review Important 1): asked again at once, a cannot-tell made every open tab run the check on every
  // re-scan for its whole life on the machines that answer it. It is kept UNKNOWN_KEEP_MS, then asked again.
  it('keeps a cannot-tell for a minute, then asks again, and says so once per session', async () => {
    let reads = 0
    let t = 1_000_000
    const logs: string[] = []
    const check = rolloutOwnerCheck({
      read: async (): Promise<RolloutOwnership> => {
        reads++
        return { verdict: 'unknown', why: 'process 101 cannot be read (EACCES)' }
      },
      log: (m) => logs.push(m),
      now: () => t
    })
    expect((await check('/a.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
    t += UNKNOWN_KEEP_MS - 1
    expect((await check('/a.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
    expect(reads).toBe(1)
    t += 1
    expect((await check('/a.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
    expect(reads).toBe(2)
    // Another file is another question
    expect((await check('/b.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
    expect(reads).toBe(3)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/session=ses_1/)
    expect(logs[0]).toMatch(/EACCES/)
    await check('/a.jsonl', 11, 'ses_2')
    expect(logs).toHaveLength(2)
  })

  // The Host's spawner, its Slack watcher and its rolling coordinator can each be looking for one session's file: one
  // PowerShell for all of them, and each says in its own log why it skipped the file.
  it('shares answers between checks over one reader, and each logs its own skip', async () => {
    let reads = 0
    const read = async (): Promise<RolloutOwnership> => {
      reads++
      return { verdict: 'other', why: 'held open by no process' }
    }
    const a: string[] = []
    const b: string[] = []
    await rolloutOwnerCheck({ read, log: (m) => a.push(m) })('C:\\a.jsonl', 10, 'ses_1')
    await rolloutOwnerCheck({ read, log: (m) => b.push(m) })('C:\\a.jsonl', 10, 'ses_1')
    expect(reads).toBe(1)
    expect([a.length, b.length]).toEqual([1, 1])
  })

  // One reader per platform in a process, so one Windows PowerShell helper for the app and one for the Host
  it('gives every caller on a platform the same reader', () => {
    expect(rolloutOwnerReader('linux')).toBe(rolloutOwnerReader('linux'))
    expect(rolloutOwnerReader('win32')).toBe(rolloutOwnerReader('win32'))
    expect(rolloutOwnerReader('win32')).not.toBe(rolloutOwnerReader('linux'))
  })

  it('turns a reader that throws into cannot-tell', async () => {
    const check = rolloutOwnerCheck({ read: async () => Promise.reject(new Error('boom')), log: () => {} })
    expect((await check('/a.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
  })
})
