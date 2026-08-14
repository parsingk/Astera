// Python interpreter discovery. No node:* imports — same split as jdk.ts: pure decisions here,
// fs/execFile in src/main/pythonScanner.ts.

/** A single detected Python interpreter. Unlike a Jdk there is no "home" directory to derive a bin
 *  from — the path is the interpreter executable itself. */
export interface PythonInterpreter {
  path: string
  /** e.g. "3.11.4" */
  version: string
}

/** venv interpreter candidates inside the project. Layout is convention, not standard, and differs by
 *  platform — win32 puts the interpreter under Scripts, posix under bin. .venv is checked first: it is
 *  the modern default (venv, virtualenv, uv and poetry all create it by that name), venv is the older one. */
export function venvInterpreterPaths(projectPath: string, platform: string): string[] {
  const sep = platform === 'win32' ? '\\' : '/'
  const tail = platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  return ['.venv', 'venv'].map((dir) => [projectPath, dir, ...tail].join(sep))
}

/** Executable names to look up on PATH. posix checks python3 first — some systems still point a bare
 *  `python` at Python 2. */
export function pythonBinNames(platform: string): string[] {
  return platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']
}

/** Parses `python --version`/`python3 --version` output. Python 3.4+ writes this to stdout; Python 2
 *  wrote it to stderr — so, like parseJavaVersion, the caller passes stdout+stderr combined.
 *  Returns null when no version token is found — that candidate is dropped, not failed.
 *
 *  The captured token must start with a digit — a bare `\S+` also matches the Windows Store
 *  app-execution-alias's own "Python was not found; run without arguments to install from the
 *  Microsoft Store…" message, reading "was" as the version. Today that stub never reaches this
 *  function at all (execFile fails to spawn the reparse point), but that is an exec-semantics side
 *  effect, not something this parser should rely on — parseJavaVersion anchors on a quoted version
 *  token for the same reason. */
export function parsePythonVersion(output: string): string | null {
  return output.match(/Python\s+(\d\S*)/)?.[1] ?? null
}

/** Whether the project root looks like a Python project. This only decides whether RunTypePicker
 *  promotes 'python'/'pytest' into its "detected" group — unlike npm scripts or Gradle tasks, nothing
 *  in a Python project names a single entry point, so there is no auto-seeded run configuration to key
 *  detection off of the way seedKeyOf does for the other kinds. */
export function hasPythonProject(files: string[]): boolean {
  return files.some((f) => f === 'pyproject.toml' || f === 'requirements.txt' || f.toLowerCase().endsWith('.py'))
}
