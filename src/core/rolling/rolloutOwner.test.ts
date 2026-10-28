import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WINDOWS_OWNER_PS1,
  linuxOwnerReader,
  macOwnerReader,
  rolloutOwnerCheck,
  rolloutOwnerReader,
  windowsOwnerReader,
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

describe('windowsOwnerReader', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-rowner-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  // Review Minor 6: no -EncodedCommand, a pattern security tools flag. The script is a file, written once under a
  // content name, run with -File as the desk helper is; the file and the pid are its arguments.
  it('runs its script file with -File, the file and the pid as arguments', async () => {
    const calls: string[][] = []
    const read = windowsOwnerReader(async (file, args) => {
      calls.push([file, ...args])
      return { code: 0, stdout: 'own|1234\r\n', stderr: '' }
    }, dir)
    const file = "C:\\Users\\o'neil\\.codex\\sessions\\2026\\10\\28\\rollout-x.jsonl"
    expect(await read(file, 1234)).toEqual({ verdict: 'own' })
    expect(await read(file, 1234)).toEqual({ verdict: 'own' })
    expect(calls).toHaveLength(2)
    const [exe, ...args] = calls[0]
    expect(exe).toBe('powershell.exe')
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
    expect(args.slice(6)).toEqual([file, '1234'])
    expect(calls[0].join(' ')).not.toMatch(/-Enc/i)
    const script = args[5]
    expect(path.dirname(script)).toBe(dir)
    expect(await fs.readFile(script, 'utf8')).toBe(WINDOWS_OWNER_PS1)
    expect((await fs.readdir(dir)).length).toBe(1)
  })

  // Windows PowerShell reads a script with no byte order mark in the ANSI code page
  it('keeps its script to ASCII', () => {
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(WINDOWS_OWNER_PS1)).toBe(true)
    expect(WINDOWS_OWNER_PS1).toContain('RmGetList')
  })

  it('writes the script again when it was changed', async () => {
    const calls: string[][] = []
    const read = windowsOwnerReader(async (file, args) => {
      calls.push([file, ...args])
      return { code: 0, stdout: 'own|1\r\n', stderr: '' }
    }, dir)
    await read('C:\\x.jsonl', 1)
    await fs.writeFile(calls[0][6], 'tampered', 'utf8')
    await read('C:\\x.jsonl', 1)
    expect(await fs.readFile(calls[0][6], 'utf8')).toBe(WINDOWS_OWNER_PS1)
  })

  it('passes on an other verdict with its reason', async () => {
    const read = windowsOwnerReader(async () => ({ code: 0, stdout: 'other|held by pid 97252 outside the session\r\n', stderr: '' }), dir)
    expect(await read('C:\\x.jsonl', 10)).toEqual({ verdict: 'other', why: 'held by pid 97252 outside the session' })
  })

  it('cannot tell when PowerShell cannot run, times out, or cannot compile the helper', async () => {
    const missing = windowsOwnerReader(async () => {
      throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })
    }, dir)
    expect((await missing('C:\\x.jsonl', 10)).verdict).toBe('unknown')
    const slow = windowsOwnerReader(async () => {
      throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null })
    }, dir)
    expect((await slow('C:\\x.jsonl', 10)).verdict).toBe('unknown')
    // Constrained Language Mode refuses Add-Type: the script's own catch says unknown
    const refused = windowsOwnerReader(async () => ({ code: 0, stdout: 'unknown|Cannot add type.\r\n', stderr: '' }), dir)
    expect((await refused('C:\\x.jsonl', 10)).verdict).toBe('unknown')
    const silent = windowsOwnerReader(async () => ({ code: 1, stdout: '', stderr: '' }), dir)
    expect((await silent('C:\\x.jsonl', 10)).verdict).toBe('unknown')
  })

  // Review Important 1, the Windows half, is in the script: a process OpenProcess cannot open is "cannot tell" unless
  // it is gone (ERROR_INVALID_PARAMETER), and a walk that stops on one answers unknown when nothing resolved to own.
  it('says in the script that a process it cannot open is cannot-tell, and only error 87 is gone', () => {
    expect(WINDOWS_OWNER_PS1).toContain('87')
    expect(WINDOWS_OWNER_PS1).toMatch(/unknown\|/)
  })

  it('never runs for a pid that is not a whole number', async () => {
    let ran = false
    const read = windowsOwnerReader(async () => {
      ran = true
      return { code: 0, stdout: 'own|1\r\n', stderr: '' }
    }, dir)
    expect((await read('C:\\x.jsonl', 1.5)).verdict).toBe('unknown')
    expect(ran).toBe(false)
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
  it('asks again after a cannot-tell, and says so once per session', async () => {
    let reads = 0
    const logs: string[] = []
    const check = rolloutOwnerCheck({
      read: async (): Promise<RolloutOwnership> => {
        reads++
        return { verdict: 'unknown', why: 'process 101 cannot be read (EACCES)' }
      },
      log: (m) => logs.push(m)
    })
    expect((await check('/a.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
    expect((await check('/a.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
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

  it('gives every caller on a platform the same reader', () => {
    expect(rolloutOwnerReader('linux')).toBe(rolloutOwnerReader('linux'))
  })

  it('turns a reader that throws into cannot-tell', async () => {
    const check = rolloutOwnerCheck({ read: async () => Promise.reject(new Error('boom')), log: () => {} })
    expect((await check('/a.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
  })
})
