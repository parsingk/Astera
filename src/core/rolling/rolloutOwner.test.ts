import { describe, expect, it } from 'vitest'
import {
  linuxOwnerReader,
  macOwnerReader,
  rolloutOwnerCheck,
  rolloutOwnerReader,
  windowsOwnerReader,
  windowsOwnerScript,
  type ProcFs,
  type RolloutOwnership,
  type RunTool
} from './rolloutOwner'

const FILE = '/home/u/.codex/sessions/2026/10/28/rollout-2026-10-28T10-00-00-019f.jsonl'

/** A /proc with `procs` (pid → ppid and the paths its fds point at). */
const procFs = (procs: Record<number, { ppid: number; fds?: string[] }>, o: { noProc?: boolean } = {}): ProcFs => ({
  readdir: async (p) => {
    if (p === '/proc') {
      if (o.noProc) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return [...Object.keys(procs), 'self', 'stat']
    }
    const m = /^\/proc\/(\d+)\/fd$/.exec(p)
    const proc = m ? procs[Number(m[1])] : undefined
    if (!proc) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return (proc.fds ?? []).map((_, i) => String(i))
  },
  readFile: async (p) => {
    const m = /^\/proc\/(\d+)\/stat$/.exec(p)
    const proc = m ? procs[Number(m[1])] : undefined
    if (!proc) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    // The command name may hold spaces and parentheses: fields are counted from the last ')'
    return `${m![1]} (co dex) (x) S ${proc.ppid} 1 1 0 -1 4194304`
  },
  readlink: async (p) => {
    const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(p)
    const fd = m ? procs[Number(m[1])]?.fds?.[Number(m[2])] : undefined
    if (fd === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return fd
  },
  realpath: async (p) => p
})

describe('linuxOwnerReader', () => {
  it('says own when a process under the session holds the file open', async () => {
    // 100 is the pty's process (the npm shim), 101 the native codex it started
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 100: { ppid: 1 }, 101: { ppid: 100, fds: ['/dev/pts/3', FILE] } }))
    expect(await read(FILE, 100)).toEqual({ verdict: 'own' })
  })

  it('says other when only a process outside the session holds it', async () => {
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 100: { ppid: 1, fds: ['/dev/pts/3'] }, 200: { ppid: 1, fds: [FILE] } }))
    const r = await read(FILE, 100)
    expect(r.verdict).toBe('other')
  })

  it('says other when the session process is gone', async () => {
    const read = linuxOwnerReader(procFs({ 1: { ppid: 0 }, 200: { ppid: 1, fds: [FILE] } }))
    expect((await read(FILE, 100)).verdict).toBe('other')
  })

  it('says unknown when /proc cannot be read', async () => {
    const read = linuxOwnerReader(procFs({}, { noProc: true }))
    expect((await read(FILE, 100)).verdict).toBe('unknown')
  })
})

/** A run that answers `lsof` and `ps` from tables, or throws for a tool that is missing. */
const tools = (t: { lsof?: { code: number; stdout: string } | 'missing'; ps?: string }): { run: RunTool; calls: string[][] } => {
  const calls: string[][] = []
  const run: RunTool = async (file, args) => {
    calls.push([file, ...args])
    if (file.endsWith('lsof')) {
      if (t.lsof === 'missing' || t.lsof === undefined) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
      return t.lsof
    }
    if (file.endsWith('ps')) return { code: 0, stdout: t.ps ?? '' }
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

  it('says unknown when lsof is missing', async () => {
    const r = await macOwnerReader(tools({ lsof: 'missing', ps }).run)(FILE, 300)
    expect(r.verdict).toBe('unknown')
  })
})

describe('windowsOwnerReader', () => {
  const decoded = (args: string[]): string => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')

  it('runs one PowerShell that asks Restart Manager, and reads its verdict line', async () => {
    const calls: string[][] = []
    const read = windowsOwnerReader(async (file, args) => {
      calls.push([file, ...args])
      return { code: 0, stdout: 'own|1234\r\n' }
    })
    const file = "C:\\Users\\o'neil\\.codex\\sessions\\2026\\10\\28\\rollout-x.jsonl"
    expect(await read(file, 1234)).toEqual({ verdict: 'own' })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('powershell.exe')
    const script = decoded(calls[0])
    expect(script).toContain('RmGetList')
    // The path is a PowerShell single-quoted literal, its quote doubled; the pid a number
    expect(script).toContain("'C:\\Users\\o''neil\\.codex\\sessions\\2026\\10\\28\\rollout-x.jsonl'")
    expect(script).toContain(', 1234)')
  })

  it('passes on an other verdict with its reason', async () => {
    const read = windowsOwnerReader(async () => ({ code: 0, stdout: 'other|held by pid 97252 outside the session\r\n' }))
    expect(await read('C:\\x.jsonl', 10)).toEqual({ verdict: 'other', why: 'held by pid 97252 outside the session' })
  })

  it('says unknown when PowerShell cannot run or cannot compile the helper', async () => {
    const missing = windowsOwnerReader(async () => {
      throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })
    })
    expect((await missing('C:\\x.jsonl', 10)).verdict).toBe('unknown')
    // Constrained Language Mode refuses Add-Type: the script's own catch says unknown
    const refused = windowsOwnerReader(async () => ({ code: 0, stdout: 'unknown|Cannot add type. Definition of new types is not supported in this language mode.\r\n' }))
    expect((await refused('C:\\x.jsonl', 10)).verdict).toBe('unknown')
    const silent = windowsOwnerReader(async () => ({ code: 1, stdout: '' }))
    expect((await silent('C:\\x.jsonl', 10)).verdict).toBe('unknown')
  })

  it('never puts a pid into the script that is not a whole number', () => {
    expect(() => windowsOwnerScript('C:\\x.jsonl', 1.5)).toThrow()
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

  it('says once that this machine cannot tell, and keeps answering unknown', async () => {
    const logs: string[] = []
    const check = rolloutOwnerCheck({ read: async () => ({ verdict: 'unknown', why: 'lsof could not run' }), log: (m) => logs.push(m) })
    expect((await check('/a.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
    expect((await check('/b.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/lsof could not run/)
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

  it('turns a reader that throws into unknown', async () => {
    const check = rolloutOwnerCheck({ read: async () => Promise.reject(new Error('boom')), log: () => {} })
    expect((await check('/a.jsonl', 10, 'ses_1')).verdict).toBe('unknown')
  })
})
