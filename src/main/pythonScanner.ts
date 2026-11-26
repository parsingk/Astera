import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { foldPathCase } from '../core/files/paths'
import {
  venvInterpreterPaths,
  pythonBinNames,
  parsePythonVersion,
  pathPythonCandidates,
  type PythonInterpreter
} from '../core/run/python'
import { defaultCwdProbe, type Probe } from '../core/sessions/pathProbe'

/** Python interpreter discovery. The pure decisions (candidate paths, output parsing, which `where`
 *  lines to drop) live in core/run/python.ts; this is the main-only layer that actually runs fs.access
 *  and execFile against those results — the same split as jdkScanner.ts.
 *
 *  Cached per project, like jdkScanner's cache (a promise, so two opens at once share one scan). It
 *  was once left uncached on purpose: a venv is created inside the project *while the app is open*
 *  (`python -m venv .venv` in the project terminal is the ordinary way to start), and a cache that
 *  never invalidated hid it until a restart. So the cache is keyed on which of the project's venv
 *  interpreters exist — two fs.access calls, checked on every open — and on the PATH string; a venv
 *  appearing or going away, or PATH changing (a late login-shell PATH), rescans. What stays cached is the expensive part: `where`/`which` and every `--version`
 *  probe, which on a machine with the Store alias on PATH could hold the dialog for seconds each time
 *  it opened. */

export interface PythonScannerDeps {
  platform: NodeJS.Platform
  /** Resolves when the path exists (fs.access). */
  access: (p: string) => Promise<void>
  /** `where`/`which` output for one executable name; '' when it finds nothing. */
  findOnPath: (name: string) => Promise<string>
  /** `<exe> --version` stdout+stderr; '' when it fails. */
  version: (exe: string) => Promise<string>
  /** The PATH the lookups run under, read on every open. Part of the cache key: on macOS/Linux the
   *  login-shell PATH can be applied after a first scan (main/startup.ts stops waiting for it at 6 s,
   *  but applyLoginPath still patches it when the shell answers). Defaults to process.env.PATH. */
  envPath?: () => string | undefined
  /** Asked once about the project folder before its venv checks (the budgeted session-folder probe,
   *  defaultCwdProbe, by default). See `lookup`. */
  gate?: Probe
}

const liveDeps: PythonScannerDeps = {
  platform: process.platform,
  access: (p) => fs.access(p),
  // where/which are shell built-ins that look a bare name up on PATH, so shell:true is correct for
  // them — different in kind from the absolute-path execution in `version`.
  findOnPath: (name) =>
    new Promise((resolve) => {
      const finder = process.platform === 'win32' ? 'where' : 'which'
      execFile(finder, [name], { shell: true, timeout: 5000, windowsHide: true }, (err, stdout) =>
        resolve(err ? '' : String(stdout))
      )
    }),
  // No shell:true — candidate paths contain spaces (e.g. a project path or `Program Files`), and going
  // through a shell would split the unquoted absolute path into tokens (same reasoning as jdkScanner's
  // verify()). Python 3.4+ writes the version to stdout; Python 2 wrote it to stderr — both are passed.
  version: (exe) =>
    new Promise((resolve) => {
      execFile(exe, ['--version'], { timeout: 5000, windowsHide: true }, (_err, stdout, stderr) =>
        resolve(`${stdout}\n${stderr}`)
      )
    })
}

export interface PythonScanner {
  /** The detected interpreters for one project: its venv (if any) plus whatever is on PATH, deduped.
   *  Never rejects — a scan that fails answers what it could confirm (possibly nothing). */
  list(projectPath: string): Promise<PythonInterpreter[]>
  /** The interpreters outside the project, nothing inside it checked or run (Phase 3 Part 3). Never rejects. */
  listOutside(projectPath: string): Promise<PythonInterpreter[]>
}

export function createPythonScanner(deps: PythonScannerDeps = liveDeps): PythonScanner {
  const cache = new Map<string, { venvKey: string; result: Promise<PythonInterpreter[]> }>()
  const envPath = deps.envPath ?? ((): string | undefined => process.env.PATH)

  const exists = (p: string): Promise<boolean> =>
    deps.access(p).then(
      () => true,
      () => false
    )

  /** Checks whether one candidate is a real interpreter — it exists, and `--version` names a version.
   *  Returns null (never throws) so a candidate that is not actually installed just drops out; a
   *  machine with no Python must still be able to type an interpreter path in by hand. */
  const verify = async (candidate: string): Promise<PythonInterpreter | null> => {
    if (!(await exists(candidate))) return null
    try {
      const version = parsePythonVersion(await deps.version(candidate))
      return version ? { path: candidate, version } : null
    } catch {
      return null
    }
  }

  /** Everything pythonBinNames resolves to on PATH, Store aliases left out (pathPythonCandidates). */
  const pathPythons = async (): Promise<string[]> => {
    const lists = await Promise.all(
      pythonBinNames(deps.platform).map((name) =>
        deps.findOnPath(name).then(pathPythonCandidates, () => [] as string[])
      )
    )
    return lists.flat()
  }

  const scan = async (venvs: string[]): Promise<PythonInterpreter[]> => {
    // Deduped before probing as well as after: `where python.exe` and `where python3.exe` often print
    // the same file, and each duplicate was one more `--version` run.
    const seen = new Set<string>()
    const candidates = [...venvs, ...(await pathPythons())].filter((c) => {
      const k = foldPathCase(c, deps.platform)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    const verified = await Promise.all(candidates.map(verify))
    const byPath = new Map<string, PythonInterpreter>()
    for (const py of verified) {
      if (!py) continue
      // The same interpreter can turn up twice, once from the venv scan and once via PATH
      const key = foldPathCase(py.path, deps.platform)
      if (!byPath.has(key)) byPath.set(key, py)
    }
    return [...byPath.values()]
  }

  const gate = deps.gate ?? defaultCwdProbe

  const lookup = async (projectPath: string, key: string): Promise<PythonInterpreter[]> => {
    // **The project folder is asked once through the probe budget first** (stage 4 T1). The venv
    // checks below run outside it, and on a dead share each can hold a libuv thread for as long as SMB
    // takes. A folder that does not answer (or whose root the budget holds as stuck) is not reachable:
    // no venv is looked for there, and the PATH interpreters are still listed. Its key says so, so the
    // next open asks again instead of keeping "no venv".
    const reachable = (await gate(projectPath).catch(() => 'timeout' as const)) !== 'timeout'
    const venvCandidates = reachable ? venvInterpreterPaths(projectPath, deps.platform) : []
    const present = await Promise.all(venvCandidates.map(exists))
    const venvs = venvCandidates.filter((_, i) => present[i])
    // Which venvs exist and the PATH `where` will search: either changing means a different answer.
    const venvKey = `${reachable ? venvs.join('\n') : '--UNREACHABLE--'}\n--PATH--\n${envPath() ?? ''}`
    const hit = cache.get(key)
    if (hit && hit.venvKey === venvKey) return hit.result
    const result = scan(venvs).catch(() => [] as PythonInterpreter[])
    cache.set(key, { venvKey, result })
    return result
  }

  /** The interpreters outside a project (Phase 3 Part 3, final review C1): what PATH resolves to, without any candidate
   *  inside the project, a venv or a PATH entry an activated venv put there, ever being checked or run. Cached per
   *  project and PATH like `list`. */
  const outsideCache = new Map<string, Promise<PythonInterpreter[]>>()
  const listOutside = (projectPath: string): Promise<PythonInterpreter[]> => {
    const root = foldPathCase(projectPath, deps.platform).replace(/[\\/]+$/, '')
    const key = `${root}\n--PATH--\n${envPath() ?? ''}`
    const hit = outsideCache.get(key)
    if (hit) return hit
    const inside = (p: string): boolean => {
      const f = foldPathCase(p, deps.platform)
      return f === root || f.startsWith(`${root}\\`) || f.startsWith(`${root}/`)
    }
    const result = pathPythons()
      .then((found) => found.filter((p) => !inside(p)))
      .then(async (candidates) => {
        const seen = new Set<string>()
        const unique = candidates.filter((c) => {
          const k = foldPathCase(c, deps.platform)
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        return (await Promise.all(unique.map(verify))).filter((p): p is PythonInterpreter => p !== null)
      })
      .catch(() => [] as PythonInterpreter[])
    outsideCache.set(key, result)
    return result
  }

  // Two opens at once share one scan without further bookkeeping: the cache holds the scan's promise
  // and is checked and set with no await in between, so whichever open finishes its venv check second
  // finds the first one's scan already there.
  return {
    list(projectPath) {
      return lookup(projectPath, foldPathCase(projectPath, deps.platform)).catch(
        () => [] as PythonInterpreter[]
      )
    },
    listOutside
  }
}

const scanner = createPythonScanner()

/** The detected Python interpreters for one project (see createPythonScanner). */
export function listPythonInterpreters(projectPath: string): Promise<PythonInterpreter[]> {
  return scanner.list(projectPath)
}

/** The detected Python interpreters outside a project, nothing of it run (createPythonScanner's listOutside). */
export function listOutsidePythonInterpreters(projectPath: string): Promise<PythonInterpreter[]> {
  return scanner.listOutside(projectPath)
}
