// Whose codex writes a rollout file (Task D, 2026-10-28). The locate (codexLocate.ts) picks its candidates by folder,
// time and "newest", and that picked another Host's session's file for an idle session in the same folder and Codex
// home: nothing in a rollout says which process wrote it. This asks the one thing only the writer has, the file held
// open, and maps a candidate to a session only when a process in that session's own process tree holds it.
//
// Why holding is the writer's evidence (openai/codex at rust-v0.160.0, commit a956835d020762cb2b570053af06f643a11c0ecc,
// codex-rs/rollout/src/recorder.rs): a new session's rollout is created by `open_log_file` (1746-1766, create and open
// in one call), at its first turn (`ensure_rollout_materialized`, core/src/session/mod.rs 5022), and the writer task
// keeps that handle (`ensure_writer_open`, 1863-1873) until it shuts down (1935-1969); only a failed write drops it
// until the next one (1848-1861). That writer is the session's own process, not a shared daemon: Astera starts codex
// with `--no-daemon` where it takes it (codexNoDaemon.ts), and with `-c` overrides, either of which keeps the TUI on
// its embedded server (tui/src/daemon_startup.rs 26-89, startup_orchestration.rs 176-183).
//
// Read once per candidate and session process, never per poll tick (rolloutOwnerCheck). Each platform reads it its
// own way: Linux from /proc, macOS with lsof and ps, Windows with Restart Manager through one PowerShell run. Only a
// positive answer rejects a candidate: held by a process outside the session's tree, or held by none. Where the
// evidence cannot be read (a tool missing or failing, a process or an fd this user may not read, a timeout), the answer
// is 'unknown': the locate keeps the rule it had before, nothing is remembered, and it is logged once per session.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { comparablePath } from '../files/tree'

export type RolloutOwnership = { verdict: 'own' } | { verdict: 'other'; why: string } | { verdict: 'unknown'; why: string }

/** Whether `file` is held open by the process `pid` or a process started under it. */
export type RolloutOwnerReader = (file: string, pid: number) => Promise<RolloutOwnership>

const OWN: RolloutOwnership = { verdict: 'own' }
const other = (why: string): RolloutOwnership => ({ verdict: 'other', why })
const unknown = (why: string): RolloutOwnership => ({ verdict: 'unknown', why })
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** How far up from a holder the walk to the session's process goes: a session's tree is a shell, a shim and codex. */
const MAX_DEPTH = 64

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** A program run to its end: its exit code, stdout and stderr. Rejects only when it could not run or was stopped
 *  (missing, timed out). */
export type RunTool = (file: string, args: string[]) => Promise<RunResult>

const RUN_TIMEOUT_MS = 20_000

const runTool: RunTool = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: RUN_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr })
      const code = (err as { code?: unknown }).code
      if (typeof code === 'number') return resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      reject(err)
    })
  })

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0] ?? ''

/** Whether `from` reaches `root` going up `parent`, within MAX_DEPTH steps. */
function under(from: number, root: number, parent: Map<number, number>): boolean {
  let p = from
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (p === root) return true
    const pp = parent.get(p)
    if (pp === undefined || pp <= 0 || pp === p) return false
    p = pp
  }
  return false
}

// ---- Linux ----

export interface ProcFs {
  readdir(p: string): Promise<string[]>
  readFile(p: string): Promise<string>
  readlink(p: string): Promise<string>
  realpath(p: string): Promise<string>
}

const realProcFs: ProcFs = {
  readdir: (p) => fs.readdir(p),
  readFile: (p) => fs.readFile(p, 'utf8'),
  readlink: (p) => fs.readlink(p),
  realpath: (p) => fs.realpath(p)
}

/** The parent pid in a /proc/<pid>/stat line: the second field after the command name, which may hold spaces and
 *  parentheses, so fields are counted from the last ')'. */
function ppidOf(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const n = Number(stat.slice(close + 1).trim().split(/\s+/)[1])
  return Number.isSafeInteger(n) ? n : null
}

/** How many /proc stat files are read at once: one open file each, and a busy machine runs hundreds of processes. */
const PROC_BATCH = 32

const codeOf = (err: unknown): string => String((err as { code?: unknown } | null)?.code ?? messageOf(err))

/** A process that ended between the listing and the read: ENOENT, or ESRCH from a /proc entry going away. */
const isGone = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ESRCH'
}

/** Linux: every process's parent from /proc/<pid>/stat, then the fds of the session's process and those under it. An
 *  orphan is re-parented to init (or a subreaper), so a parent link never names a process that reused a dead one's
 *  pid. A read that fails for any reason but the process being gone (EACCES on a non-dumpable process, EMFILE) leaves
 *  the answer at "cannot tell" unless the file was found: that process may be the session's, holding it. */
export function linuxOwnerReader(d: ProcFs = realProcFs): RolloutOwnerReader {
  return async (file, pid) => {
    let names: string[]
    try {
      names = await d.readdir('/proc')
    } catch (err) {
      return unknown(`/proc cannot be read: ${messageOf(err)}`)
    }
    let target: string
    try {
      target = await d.realpath(file)
    } catch (err) {
      return isGone(err) ? other('the file is gone') : unknown(`the file cannot be resolved (${codeOf(err)})`)
    }
    let blind: string | null = null
    const cannotRead = (what: string, err: unknown): void => {
      blind ??= `${what} cannot be read (${codeOf(err)})`
    }
    const parent = new Map<number, number>()
    const pids = names.filter((n) => /^\d+$/.test(n))
    for (let i = 0; i < pids.length; i += PROC_BATCH) {
      await Promise.all(
        pids.slice(i, i + PROC_BATCH).map(async (n) => {
          try {
            const ppid = ppidOf(await d.readFile(`/proc/${n}/stat`))
            if (ppid !== null) parent.set(Number(n), ppid)
          } catch (err) {
            if (!isGone(err)) cannotRead(`process ${n}`, err)
          }
        })
      )
    }
    if (!parent.has(pid)) return unknown(blind ?? `the session's process ${pid} is gone`)
    const tree = [...parent.keys()].filter((p) => under(p, pid, parent))
    for (const p of tree) {
      let fds: string[]
      try {
        fds = await d.readdir(`/proc/${p}/fd`)
      } catch (err) {
        if (!isGone(err)) cannotRead(`the open files of process ${p}`, err)
        continue
      }
      for (const fd of fds) {
        try {
          if ((await d.readlink(`/proc/${p}/fd/${fd}`)) === target) return OWN
        } catch (err) {
          if (!isGone(err)) cannotRead(`an open file of process ${p}`, err)
        }
      }
    }
    return blind ? unknown(blind) : other(`not open in process ${pid} or any process under it`)
  }
}

// ---- macOS ----

/** macOS: the holders from lsof (in /usr/sbin on every macOS), then each one's parents from one ps, walked up to the
 *  session's process. Orphans are re-parented to launchd, as on Linux. lsof exits 1 both when no process has the file
 *  open and on an error; only the error says anything on stderr (`-w` keeps the warnings off it). */
export function macOwnerReader(run: RunTool = runTool): RolloutOwnerReader {
  return async (file, pid) => {
    let lsof: RunResult
    try {
      lsof = await run('/usr/sbin/lsof', ['-w', '-t', '--', file])
    } catch (err) {
      return unknown(`lsof could not run: ${messageOf(err)}`)
    }
    const holders = lsof.stdout
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0)
    if (holders.includes(pid)) return OWN
    const failed = lsof.stderr.trim() !== '' || (lsof.code !== 0 && lsof.code !== 1) ? `lsof exited ${lsof.code}: ${firstLine(lsof.stderr)}` : null
    if (holders.length === 0) return failed ? unknown(failed) : other('held open by no process')
    let ps: RunResult
    try {
      ps = await run('/bin/ps', ['-A', '-o', 'pid=,ppid='])
    } catch (err) {
      return unknown(`ps could not run: ${messageOf(err)}`)
    }
    if (ps.code !== 0) return unknown(`ps exited ${ps.code}`)
    const parent = new Map<number, number>()
    for (const line of ps.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
      if (m) parent.set(Number(m[1]), Number(m[2]))
    }
    if (holders.some((h) => under(h, pid, parent))) return OWN
    // lsof that failed somewhere may have missed the session's own holder
    return failed ? unknown(failed) : other(`held by pid ${holders.join(', ')} outside the session`)
  }
}

// ---- Windows ----

/** The C# the PowerShell run compiles. Restart Manager names the processes holding a file
 *  (https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist), with each one's
 *  start time; a Toolhelp snapshot gives every process's parent
 *  (https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w). Windows does not
 *  re-parent an orphan, so a parent id can name a later process that reused it; a "parent" that started after its
 *  child is that, and ends the walk
 *  (https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process, ParentProcessId). C# 5, which
 *  Windows PowerShell 5.1 compiles. */
const WINDOWS_HELPER = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AsteraRolloutOwner {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public uint startLow; public uint startHigh; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESSENTRY32W {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID;
    public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nSvc, string[] svcs);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr h, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr h, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);

  // The start time; -2 when no such process (OpenProcess fails with ERROR_INVALID_PARAMETER, 87); -1 when it cannot be
  // read (access denied, or anything else), with the error.
  static long StartOf(int pid, out int error) {
    error = 0;
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return error == 87 ? -2 : -1; }
    try {
      long c, e, k, u;
      if (GetProcessTimes(h, out c, out e, out k, out u)) return c;
      error = Marshal.GetLastWin32Error();
      return -1;
    } finally { CloseHandle(h); }
  }

  static Dictionary<int, long> Holders(string path) {
    uint h; int rc = RmStartSession(out h, 0, Guid.NewGuid().ToString());
    if (rc != 0) throw new Exception("RmStartSession " + rc);
    try {
      rc = RmRegisterResources(h, 1, new string[] { path }, 0, IntPtr.Zero, 0, null);
      if (rc != 0) throw new Exception("RmRegisterResources " + rc);
      var found = new Dictionary<int, long>();
      for (int attempt = 0; attempt < 3; attempt++) {
        uint needed = 0, n = 0, reasons = 0;
        rc = RmGetList(h, out needed, ref n, null, ref reasons);
        if (rc == 0) return found;
        if (rc != 234) throw new Exception("RmGetList " + rc);
        var info = new RM_PROCESS_INFO[needed]; n = needed;
        rc = RmGetList(h, out needed, ref n, info, ref reasons);
        if (rc == 234) continue;
        if (rc != 0) throw new Exception("RmGetList " + rc);
        for (int i = 0; i < n; i++) found[info[i].Process.dwProcessId] = ((long)info[i].Process.startHigh << 32) | info[i].Process.startLow;
        return found;
      }
      throw new Exception("RmGetList kept growing");
    } finally { RmEndSession(h); }
  }

  static Dictionary<int, int> Parents() {
    var parent = new Dictionary<int, int>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) throw new Exception("CreateToolhelp32Snapshot " + Marshal.GetLastWin32Error());
    try {
      var e = new PROCESSENTRY32W(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) parent[(int)e.th32ProcessID] = (int)e.th32ParentProcessID;
    } finally { CloseHandle(snap); }
    return parent;
  }

  public static string Verdict(string path, int root) {
    int error;
    long rootStart = StartOf(root, out error);
    if (rootStart == -2) return "unknown|the session's process " + root + " is gone";
    if (rootStart < 0) return "unknown|the session's process " + root + " cannot be read (error " + error + ")";
    var holders = Holders(path);
    if (holders.Count == 0) return "other|held open by no process";
    if (holders.ContainsKey(root)) return "own|" + root;
    var parent = Parents();
    string blind = null;
    foreach (var holder in holders) {
      int p = holder.Key; long start = holder.Value;
      for (int depth = 0; depth < ${MAX_DEPTH}; depth++) {
        if (p == root) return "own|" + holder.Key;
        // Every process under the session's started after it: one that started earlier is not under it
        if (start < rootStart) break;
        int pp;
        if (!parent.TryGetValue(p, out pp) || pp <= 0 || pp == p) break;
        long ppStart = StartOf(pp, out error);
        // A parent that cannot be read may be the session's process or one under it
        if (ppStart == -1) { if (blind == null) blind = "process " + pp + " cannot be read (error " + error + ")"; break; }
        // Gone, or a later process that reused a dead parent's id: the walk ends there
        if (ppStart < 0 || ppStart > start) break;
        p = pp; start = ppStart;
      }
    }
    if (blind != null) return "unknown|" + blind;
    return "other|held by pid " + string.Join(", ", new List<int>(holders.Keys).ConvertAll(x => x.ToString()).ToArray()) + " outside the session";
  }
}
`

/** The script a PowerShell run executes, with the file and the session's pid as its arguments: compile the helper and
 *  print one verdict line, `own|<pid>`, `other|<why>` or `unknown|<why>`. Add-Type refused (Constrained Language
 *  Mode) is caught here and said as unknown. ASCII only: Windows PowerShell reads a script with no byte order mark in
 *  the ANSI code page. */
export const WINDOWS_OWNER_PS1 = [
  '# Whether a process under the session holds a codex rollout open, for Astera (core/rolling/rolloutOwner.ts).',
  '# Arguments: the file, the pid of the session process. Prints own|<pid>, other|<why> or unknown|<why>.',
  'param([string]$Path, [int]$Root)',
  "$ErrorActionPreference = 'Stop'",
  'try {',
  `  Add-Type -TypeDefinition @'${WINDOWS_HELPER}'@`,
  '  [AsteraRolloutOwner]::Verdict($Path, $Root)',
  "} catch { 'unknown|' + ($_.Exception.Message -replace '[\\r\\n|]', ' ') }",
  ''
].join('\n')

/** Writes the script under a content name in `dir` unless it is already there as it should be, and answers its path:
 *  the desk helper's way (host/workspace/desktopHelper.ts writeDeskScript). Checked before every run, so a changed
 *  copy is never run. */
async function writeOwnerScript(dir: string): Promise<string> {
  const hash = createHash('sha256').update(WINDOWS_OWNER_PS1).digest('hex').slice(0, 8)
  const file = path.join(dir, `astera-rollout-owner-${hash}.ps1`)
  const current = await fs.readFile(file, 'utf8').catch(() => null)
  if (current !== WINDOWS_OWNER_PS1) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, WINDOWS_OWNER_PS1, 'utf8')
  }
  return file
}

/** Windows: one Windows PowerShell run per question (about half a second, measured on this machine 2026-10-28), its
 *  script a file run with `-File` as the desk helper's is, the file and the pid passed as plain arguments. The script
 *  goes in `dir`, the user's own temp folder unless a caller names another. */
export function windowsOwnerReader(run: RunTool = runTool, dir: string = os.tmpdir()): RolloutOwnerReader {
  return async (file, pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return unknown(`not a pid: ${pid}`)
    let script: string
    try {
      script = await writeOwnerScript(dir)
    } catch (err) {
      return unknown(`the PowerShell script cannot be written: ${messageOf(err)}`)
    }
    let r: RunResult
    try {
      r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, file, String(pid)])
    } catch (err) {
      return unknown(`PowerShell could not run: ${messageOf(err)}`)
    }
    const line = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^(own|other|unknown)\|/.test(l))
    if (!line) return unknown(`PowerShell gave no verdict (exit ${r.code})`)
    const bar = line.indexOf('|')
    const verdict = line.slice(0, bar)
    const why = line.slice(bar + 1).trim()
    return verdict === 'own' ? OWN : verdict === 'other' ? other(why) : unknown(why)
  }
}

const readers = new Map<NodeJS.Platform, RolloutOwnerReader>()

/** This platform's reader, one per process, so the checks built over it share their answers (rolloutOwnerCheck). */
export function rolloutOwnerReader(platform: NodeJS.Platform): RolloutOwnerReader {
  let read = readers.get(platform)
  if (!read) {
    read =
      platform === 'win32'
        ? windowsOwnerReader()
        : platform === 'darwin'
          ? macOwnerReader()
          : platform === 'linux'
            ? linuxOwnerReader()
            : async () => unknown(`no way to read open files on ${platform}`)
    readers.set(platform, read)
  }
  return read
}

/** Asks a reader once per candidate and session process. */
export type RolloutOwnerCheck = (file: string, pid: number, sessionId: string) => Promise<RolloutOwnership>

/** How many answers are kept, and how many skips a check remembers having logged. A session asks about the few
 *  files born in its folder after it started. */
const MEMO_MAX = 256

/** Each reader's answers, by session process and candidate: shared by every check over that reader, since the
 *  Host's spawner, its Slack watcher and its rolling coordinator can be looking for one session's file at once, and
 *  a Windows answer is a PowerShell run. */
const answers = new WeakMap<RolloutOwnerReader, Map<string, Promise<RolloutOwnership>>>()

/** Drops the oldest entry once there are more than MEMO_MAX. */
const trim = (m: { size: number; keys(): IterableIterator<string>; delete(k: string): boolean }): void => {
  if (m.size > MEMO_MAX) m.delete(m.keys().next().value as string)
}

/** A caller's check: the reader asked once per (candidate, session process) and a positive answer kept, since neither
 *  who writes a file nor the session's process changes. "Cannot tell" is not kept (review Important 1: a failed read
 *  is no verdict), so the next look asks again. Logs to the caller's log why a candidate is skipped (its path, never
 *  its contents), and once per session that it cannot tell. */
export function rolloutOwnerCheck(o: { read: RolloutOwnerReader; log: (m: string) => void }): RolloutOwnerCheck {
  let memo = answers.get(o.read)
  if (!memo) answers.set(o.read, (memo = new Map()))
  const shared = memo
  const told = new Set<string>()
  return async (file, pid, sessionId) => {
    const key = `${pid}\u0000${comparablePath(file)}`
    let answer = shared.get(key)
    if (!answer) {
      const asked = o.read(file, pid).catch((err): RolloutOwnership => unknown(messageOf(err)))
      answer = asked
      shared.set(key, asked)
      trim(shared)
      void asked.then((r) => {
        if (r.verdict === 'unknown' && shared.get(key) === asked) shared.delete(key)
      })
    }
    const r = await answer
    if (r.verdict === 'other' && !told.has(key)) {
      told.add(key)
      trim(told)
      o.log(`codex rollout skipped for session=${sessionId}: ${file} (${r.why})`)
    } else if (r.verdict === 'unknown' && !told.has(`?${sessionId}`)) {
      told.add(`?${sessionId}`)
      trim(told)
      o.log(`codex rollout owner cannot be told for session=${sessionId} (${r.why}); its rollout is mapped by folder and time alone`)
    }
    return r
  }
}
