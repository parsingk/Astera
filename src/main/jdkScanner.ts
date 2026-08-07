import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { jdkSearchPaths, candidateJdkHome, parseJavaVersion, type Jdk } from '../core/run/jdk'

/** JDK discovery. The pure decisions (path computation, output parsing) live in core/run/jdk.ts; this is the
 *  main-only layer that actually runs fs.readdir and execFile against those results. */

// Cached for the lifetime of the session — a module-level variable. The set of installed JDKs barely ever changes
// while the app is running, and when it does, restarting the app rescans, which is refresh enough. Invalidation
// logic such as a file watcher would be over-engineering for what this feature is worth (YAGNI).
let cache: Promise<Jdk[]> | null = null

const JAVA_BIN = process.platform === 'win32' ? 'java.exe' : 'java'

/** Checks whether one candidate is a real JDK — confirms bin/java exists, then reads version and vendor from `java -version`. */
async function verify(javaHome: string): Promise<Jdk | null> {
  const javaExe =
    process.platform === 'win32' ? `${javaHome}\\bin\\${JAVA_BIN}` : `${javaHome}/bin/${JAVA_BIN}`
  try {
    await fs.access(javaExe)
  } catch {
    return null // Most of these paths do not exist — most scan targets simply are not installed
  }
  return new Promise((resolve) => {
    // No shell:true here — candidate paths contain spaces (e.g. `C:\Program Files\Eclipse Adoptium\...`).
    // Going through a shell splits the unquoted absolute path into tokens, which breaks the invocation or does
    // something worse. system.checkCli in ipc.ts uses shell:true because it runs a 'name' off PATH (claude/codex);
    // here an absolute path is executed directly, so no shell is the correct choice.
    execFile(javaExe, ['-version'], { timeout: 5000 }, (_err, stdout, stderr) => {
      // java -version has always written to stderr (JDK 9+ included) — reading only stdout yields an empty
      // string. Passing them combined lets parseJavaVersion find it on whichever stream it landed.
      const parsed = parseJavaVersion(`${stdout}\n${stderr}`)
      resolve(parsed ? { path: javaHome, version: parsed.version, vendor: parsed.vendor } : null)
    })
  })
}

/** Adds the java on PATH as a candidate too. where/which are themselves shell built-ins that look a 'name' up on
 *  PATH, so shell:true is right for them — different in kind from verify()'s absolute-path execution. */
function pathJavaHome(): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    execFile(finder, ['java'], { shell: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      const first = stdout
        .split(/\r\n|\r|\n/)
        .map((l) => l.trim())
        .find(Boolean)
      if (!first) return resolve(null)
      // For a <jdk>/bin/java(.exe) shape, JAVA_HOME is two levels up
      const parts = first.split(/[\\/]/)
      if (parts.length < 3) return resolve(null)
      const sep = process.platform === 'win32' ? '\\' : '/'
      resolve(parts.slice(0, -2).join(sep))
    })
  })
}

async function scanCandidates(): Promise<string[]> {
  const { direct, scanParents } = jdkSearchPaths(process.platform, {
    javaHome: process.env.JAVA_HOME,
    programFiles: process.env.ProgramFiles,
    localAppData: process.env.LOCALAPPDATA,
    home: os.homedir()
  })
  const candidates = [...direct]
  await Promise.all(
    scanParents.map(async (parent) => {
      let subdirs: string[] = []
      try {
        subdirs = (await fs.readdir(parent, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      } catch {
        return // Most of these paths do not exist — skip silently
      }
      for (const name of subdirs) candidates.push(candidateJdkHome(parent, name, process.platform))
    })
  )
  const pathHome = await pathJavaHome()
  if (pathHome) candidates.push(pathHome)
  return candidates
}

/** Compares only the leading numeric/separator sequence of the version string — so "17.0.9+9" with a +build suffix still compares. */
function versionKey(v: string): number[] {
  const numeric = v.match(/^[0-9]+(?:[._][0-9]+)*/)?.[0] ?? '0'
  return numeric.split(/[._]/).map(Number)
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = versionKey(a)
  const pb = versionKey(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/** The detected JDKs — cached for the session (module-level variable), verified in parallel, sorted by version
 *  descending, deduped by resolved path (case ignored on win32 only — the same install can be found twice via
 *  different scan paths, e.g. the java on PATH also turning up in a directory scan). */
export function listJdks(): Promise<Jdk[]> {
  if (!cache) {
    cache = (async () => {
      const candidates = await scanCandidates()
      const verified = await Promise.all(candidates.map(verify))
      const byPath = new Map<string, Jdk>()
      for (const jdk of verified) {
        if (!jdk) continue
        const key = process.platform === 'win32' ? jdk.path.toLowerCase() : jdk.path
        if (!byPath.has(key)) byPath.set(key, jdk)
      }
      return [...byPath.values()].sort((a, b) => compareVersionsDesc(a.version, b.version))
    })()
  }
  return cache
}
