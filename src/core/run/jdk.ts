// JDK discovery. No node:* imports — only pure modules can be verified automatically in this repo
// (vitest environment: 'node' — no jsdom. The fs/child_process scanner on the main side is src/main/jdkScanner.ts).
// Same approach as IntelliJ's JavaHomeFinder: do not read the registry, scan the conventional directories instead.

/** A single detected JDK. */
export interface Jdk {
  /** The path to set as JAVA_HOME */
  path: string
  /** e.g. "21.0.5" */
  version: string
  /** e.g. "Temurin". null when it cannot be read */
  vendor: string | null
}

/** The scan targets jdkSearchPaths returns. Each direct entry is itself a candidate (the caller checks existence and
 *  bin/java validity with fs); each scanParents entry is a parent directory to walk one level down — every subfolder under it is a candidate. */
export interface JdkSearchPaths {
  direct: string[]
  scanParents: string[]
}

// The only scan parent on posix that uses the macOS bundle layout — candidateJdkHome compares against this
// value to decide whether the Contents/Home fixup applies.
const MACOS_JVM_ROOT = '/Library/Java/JavaVirtualMachines'

/** Joins path parts with the platform separator, without node:path (this module must not import node:*). */
function join(platform: string, ...parts: string[]): string {
  const sep = platform === 'win32' ? '\\' : '/'
  return parts.join(sep)
}

/**
 * Computes the locations to scan (the IntelliJ JavaHomeFinder approach). env is injected by the caller (main) —
 * reading process.env here would break purity and make the module unimportable from the renderer.
 * env keys with no value are skipped — an empty string mixed in as a path segment builds a path nobody intended.
 *
 * Why there is no dedup: within one platform branch, every scanParents entry appends a different fixed suffix
 * (\Java, \Eclipse Adoptium, ...), so even when two env values happen to be equal the resulting strings do not
 * collide. Real duplicates (for example the java on PATH pointing at the same JDK the directory scan also finds)
 * can only be recognised *after* fs.readdir has listed the actual subdirectories, so that is the scanner's
 * responsibility (jdkScanner.ts) — the duplicates this function could produce do not exist, so dedup logic here would be pointless.
 */
export function jdkSearchPaths(
  platform: string,
  env: { javaHome?: string; programFiles?: string; localAppData?: string; home?: string }
): JdkSearchPaths {
  const direct: string[] = []
  if (env.javaHome) direct.push(env.javaHome)

  const scanParents: string[] = []
  if (platform === 'win32') {
    if (env.programFiles) {
      scanParents.push(
        join(platform, env.programFiles, 'Java'),
        join(platform, env.programFiles, 'Eclipse Adoptium'),
        join(platform, env.programFiles, 'Microsoft'),
        join(platform, env.programFiles, 'Amazon Corretto'),
        join(platform, env.programFiles, 'Zulu')
      )
    }
    if (env.localAppData) {
      scanParents.push(join(platform, env.localAppData, 'Programs', 'Eclipse Adoptium'))
    }
  } else {
    scanParents.push('/usr/lib/jvm', MACOS_JVM_ROOT)
    if (env.home) scanParents.push(join(platform, env.home, '.sdkman', 'candidates', 'java'))
  }
  // Common to both: JDKs Gradle downloaded as toolchains (win32 and posix alike)
  if (env.home) scanParents.push(join(platform, env.home, '.gradle', 'jdks'))

  return { direct, scanParents }
}

/**
 * Builds the actual JAVA_HOME candidate path from a subdirectory name fs.readdir found under a scan parent (one
 * scanParents entry). On macOS the real JAVA_HOME for `/Library/Java/JavaVirtualMachines/<x>` is
 * `<x>/Contents/Home` (the top level of `<x>` has no bin/java) — this fixup was pulled into the pure module so
 * the scanner (main, fs access) only has to pass a list of names, which keeps it unit-testable without fs.
 */
export function candidateJdkHome(scanParent: string, childName: string, platform: string): string {
  const home = join(platform, scanParent, childName)
  if (platform !== 'win32' && scanParent === MACOS_JVM_ROOT) {
    return join(platform, home, 'Contents', 'Home')
  }
  return home
}

// Vendor names commonly seen in `java -version` output. There is no priority order — the first match wins, because
// in practice a single output never carries several of these names at once.
const VENDOR_MARKERS = ['Temurin', 'Corretto', 'Zulu', 'GraalVM', 'Microsoft', 'Semeru']

/**
 * Parses `java -version` output. This command has always written to **stderr** (JDK 9+ included), so the caller
 * must pass stdout+stderr combined — reading only stdout yields an empty string.
 * Returns null when parsing fails (no version string found) — that candidate is dropped from the list (a skip, not a failure).
 *
 * The vendor is searched across the whole output, not just the "Runtime Environment" line. Restricting it to that
 * line looks tempting, but IBM Semeru's real output has "Runtime Open Edition" there and never contains the literal
 * "Runtime Environment" (verified against actual output), so a line-restricted search would make Semeru vendor
 * detection impossible. Searching the whole output carries essentially no false-positive risk — each marker is a
 * very distinctive proper noun that does not turn up by accident in another context.
 */
export function parseJavaVersion(output: string): { version: string; vendor: string | null } | null {
  const versionMatch = output.match(/version "([^"]+)"/)
  if (!versionMatch) return null
  const version = versionMatch[1]
  const vendor = VENDOR_MARKERS.find((name) => output.includes(name)) ?? null
  return { version, vendor }
}

/**
 * Returns env with the `bin` of the JAVA_HOME the config specified prepended to PATH.
 *
 * Why this is needed: the JDK field only sets JAVA_HOME. gradlew and mvnw read it, so those are fine, but when the
 * command invokes `java` directly (`java -jar build\libs\app.jar`) java resolves off PATH and the chosen JDK is
 * ignored — the UI then falsely reports a selection that never took effect.
 *
 * Why at spawn time: freezing PATH into the stored value fossilises the PATH as it was at that moment. It has to be
 * computed when the command runs.
 *
 * Windows key casing: process.env is a special object that supports case-insensitive access on win32, but spreading
 * it with `{ ...process.env }` produces an ordinary case-sensitive object whose real key is usually `Path`. Assigning
 * `env.PATH = ...` on top of that leaves both `Path` and `PATH` present, and which one the child sees becomes
 * uncertain. So the existing key is looked up case-insensitively and **that key** is the one updated.
 *
 * When javaHome is empty, env is returned as-is (the same reference) — the caller only passes it when the config specified one.
 */
export function withJavaHomeOnPath(
  env: Record<string, string | undefined>,
  javaHome: string | undefined,
  platform: string
): Record<string, string | undefined> {
  const home = javaHome?.trim()
  if (!home) return env
  const sep = platform === 'win32' ? '\\' : '/'
  // Strip any trailing separator before appending bin — joining `C:\jdk\` as-is would yield `C:\jdk\\bin`
  const binDir = join(platform, home.replace(/[\\/]+$/, ''), 'bin')
  const delimiter = platform === 'win32' ? ';' : ':'
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const current = env[pathKey]
  return { ...env, [pathKey]: current ? `${binDir}${delimiter}${current}` : binDir }
}
