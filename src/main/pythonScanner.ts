import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import {
  venvInterpreterPaths,
  pythonBinNames,
  parsePythonVersion,
  type PythonInterpreter
} from '../core/run/python'

/** Python interpreter discovery. The pure decisions (candidate paths, output parsing) live in
 *  core/run/python.ts; this is the main-only layer that actually runs fs.access and execFile against
 *  those results — the same split as jdkScanner.ts.
 *
 *  Deliberately not cached, the same call dotnetScanner.ts makes and for the same reason: a venv is
 *  created inside the project *while the app is open* (`python -m venv .venv` in the project terminal
 *  is the ordinary way to start), and a per-project cache that never invalidates meant the new
 *  interpreter could not appear until the app restarted. It ran per project path, so it did not even
 *  answer with the wrong project's venv — it simply went stale with nothing able to refresh it.
 *  The cost of rescanning is a handful of short-lived `--version` probes on a deliberate user action
 *  (opening the run configuration dialog), which is the same bargain dotnetScanner already takes.
 *  jdkScanner keeps its session-wide cache because a JDK is installed outside the app, not made inside
 *  the project the app is looking at. */

/** Checks whether one candidate path is a real interpreter — confirms it exists, then reads the
 *  version from `--version`. Returns null (never throws) so a candidate that is not actually installed
 *  just drops out of the list; a machine with no Python must still be able to create a Python run
 *  configuration by typing the interpreter path in by hand. */
async function verify(candidate: string): Promise<PythonInterpreter | null> {
  try {
    await fs.access(candidate)
  } catch {
    return null // most scan targets simply are not installed
  }
  return new Promise((resolve) => {
    // No shell:true — candidate paths contain spaces (e.g. a project path or `Program Files`), and
    // going through a shell would split the unquoted absolute path into tokens (same reasoning as
    // jdkScanner's verify()).
    execFile(candidate, ['--version'], { timeout: 5000 }, (_err, stdout, stderr) => {
      // Python 3.4+ writes this to stdout; Python 2 wrote it to stderr — combine both like
      // parseJavaVersion does, so whichever stream it landed on is still found.
      const version = parsePythonVersion(`${stdout}\n${stderr}`)
      resolve(version ? { path: candidate, version } : null)
    })
  })
}

/** Everything pythonBinNames resolves to on PATH (where/which are shell built-ins that look a bare
 *  name up on PATH, so shell:true is correct for them — different in kind from verify()'s absolute-path
 *  execution). Both names are tried; verify()'s existence check and the dedup below settle which of
 *  them, if any, turn out to be real. */
function pathPythons(): Promise<string[]> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  return Promise.all(
    pythonBinNames(process.platform).map(
      (name) =>
        new Promise<string[]>((resolve) => {
          execFile(finder, [name], { shell: true, timeout: 5000 }, (err, stdout) => {
            if (err) return resolve([])
            resolve(
              stdout
                .split(/\r\n|\r|\n/)
                .map((l) => l.trim())
                .filter(Boolean)
            )
          })
        })
    )
  ).then((lists) => lists.flat())
}

/** The detected Python interpreters for one project: its venv (if any) plus whatever pythonBinNames
 *  resolves to on PATH. Verified in parallel, deduped by resolved path (case ignored on win32 only —
 *  the same interpreter can turn up twice, once from the venv scan and once via PATH). */
export async function listPythonInterpreters(projectPath: string): Promise<PythonInterpreter[]> {
  const candidates = [...venvInterpreterPaths(projectPath, process.platform), ...(await pathPythons())]
  const verified = await Promise.all(candidates.map(verify))
  const byPath = new Map<string, PythonInterpreter>()
  for (const py of verified) {
    if (!py) continue
    const key = process.platform === 'win32' ? py.path.toLowerCase() : py.path
    if (!byPath.has(key)) byPath.set(key, py)
  }
  return [...byPath.values()]
}
