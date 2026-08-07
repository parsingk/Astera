// Project run configurations. Language-agnostic free-form commands, plus auto-seeded entries for common cases.
export interface RunConfig {
  id: string
  name: string
  command: string
  cwd?: string
  env?: Record<string, string> // Per-config environment variables — runManager layers them over process.env when spawning
}

// Live run state — used by the renderer count/dropdown and by the Run panel header
export interface RunStatus {
  projectPath: string
  projectName: string
  configId: string
  configName: string
  command: string
  status: 'running' | 'exited'
  exitCode?: number
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** Picks the package manager from the project root file list. A lockfile wins; npm otherwise. */
export function detectPackageManager(files: string[]): PackageManager {
  const set = new Set(files)
  if (set.has('pnpm-lock.yaml')) return 'pnpm'
  if (set.has('yarn.lock')) return 'yarn'
  if (set.has('bun.lockb')) return 'bun'
  return 'npm'
}

// This exact string appears both as the Gradle plugin id and as the Maven groupId — so Boot is detected by scanning the build file body
// (why the plugin's presence alone does not settle it: seeding bootRun into a project without the Boot plugin creates a config that fails)
const SPRING_BOOT_MARKER = 'org.springframework.boot'

/**
 * Builds the auto-seeded run configs from the project root file list plus the build file bodies (derived, never stored).
 * Why platform is a parameter: this module is pure and never reads process.platform itself (it is registered in
 * tsconfig.web.json, so the renderer imports it too) — the Gradle/Maven wrapper invocation differs between win32 and
 * posix, so the caller (ipc.ts) passes it in.
 * Why the type is string and not NodeJS.Platform: tsconfig.web.json has no @types/node, so the global NodeJS
 * namespace does not exist there — only 'win32' is ever compared, so string is enough.
 */
export function detectSeedConfigs(
  files: string[],
  texts: { packageJson: string | null; buildGradle: string | null; pom: string | null },
  platform: string
): RunConfig[] {
  const set = new Set(files)
  const out: RunConfig[] = []
  if (set.has('package.json') && texts.packageJson) {
    const pm = detectPackageManager(files)
    let scripts: Record<string, unknown> | undefined
    try {
      const parsed = JSON.parse(texts.packageJson)
      if (parsed && typeof parsed === 'object') scripts = parsed.scripts
    } catch {
      /* Ignore a malformed package.json */
    }
    if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
      for (const key of Object.keys(scripts)) {
        const command = `${pm} run ${key}`
        out.push({ id: `seed:${command}`, name: command, command })
      }
    }
  }
  if (set.has('Cargo.toml')) out.push({ id: 'seed:cargo run', name: 'cargo run', command: 'cargo run' })
  if (set.has('go.mod')) out.push({ id: 'seed:go run .', name: 'go run .', command: 'go run .' })

  // Gradle: the platform's wrapper when one is present, otherwise the global gradle.
  // posix runs through sh -c, which only searches PATH, so a bare 'gradlew' without './' never finds the executable — './gradlew' is required.
  // win32 runs through cmd.exe /c, which looks in the current directory first, so 'gradlew.bat' alone is enough.
  if (set.has('build.gradle') || set.has('build.gradle.kts')) {
    const runner =
      platform === 'win32' ? (set.has('gradlew.bat') ? 'gradlew.bat' : 'gradle') : set.has('gradlew') ? './gradlew' : 'gradle'
    // Limitation: in a multi-module Gradle build the Boot plugin may live only in a subproject, so when the root
    // body does not mention it only build/test get seeded. Those configs still work, so this stays as an acceptable heuristic.
    const isBoot = !!texts.buildGradle && texts.buildGradle.includes(SPRING_BOOT_MARKER)
    for (const task of isBoot ? ['bootRun', 'test', 'build'] : ['build', 'test']) {
      const command = `${runner} ${task}`
      out.push({ id: `seed:${command}`, name: command, command })
    }
  }

  // Maven: the platform's wrapper when one is present, otherwise the global mvn. Same reasoning as Gradle.
  if (set.has('pom.xml')) {
    const runner =
      platform === 'win32' ? (set.has('mvnw.cmd') ? 'mvnw.cmd' : 'mvn') : set.has('mvnw') ? './mvnw' : 'mvn'
    const isBoot = !!texts.pom && texts.pom.includes(SPRING_BOOT_MARKER)
    for (const task of isBoot ? ['spring-boot:run', 'test', 'package'] : ['package', 'test']) {
      const command = `${runner} ${task}`
      out.push({ id: `seed:${command}`, name: command, command })
    }
  }

  return out
}

/** Whether the project is Spring Boot — true when a build file body contains SPRING_BOOT_MARKER. Separate from the
 *  per-build-system checks detectSeedConfigs makes locally, this exposes a project-level verdict for run.list to use
 *  when deciding whether RunConfigDialog shows the Spring profile field (buried inside that logic it could not be reused).
 *  The two isBoot checks inside detectSeedConfigs (local, per build system) are left alone — in the rare case both
 *  Gradle and Maven sit at the root, detectSeedConfigs may seed in a different order than this function reports, but
 *  those were always independent checks, so unifying them here would change the existing seed behaviour. */
export function isSpringBootProject(texts: { buildGradle: string | null; pom: string | null }): boolean {
  return (
    (!!texts.buildGradle && texts.buildGradle.includes(SPRING_BOOT_MARKER)) ||
    (!!texts.pom && texts.pom.includes(SPRING_BOOT_MARKER))
  )
}

/** Display list = stored configs + seeds whose command does not collide. Stored (user) configs come first. */
export function mergeConfigs(seed: RunConfig[], stored: RunConfig[]): RunConfig[] {
  const storedCommands = new Set(stored.map((c) => c.command))
  return [...stored, ...seed.filter((s) => !storedCommands.has(s.command))]
}

/** One `KEY=VALUE` per line → map. Blank lines and `#` comments are ignored. Splits on the first `=` only (the value may contain `=`). */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue // A line with no `=` is not KEY=VALUE, so drop it silently (guards against hand-edit typos)
    const key = line.slice(0, eq).trim()
    if (!key) continue
    // Trailing whitespace in a value is almost always left over from a paste or a line-break edit, so it gets trimmed — whitespace inside the value is preserved
    out[key] = line.slice(eq + 1).trim()
  }
  return out
}

/** Map → editable text (the inverse of parseEnvLines) */
export function formatEnvLines(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/** Splits specific env keys out so they can be edited in a dedicated field, like the JDK and Spring profile ones.
 *  RunConfigDialog uses it to keep those keys from showing up again in the environment variable textarea. The original
 *  env is never mutated (only shallow copies are returned) — the caller can go on editing rest in the textarea and the config.env original stays safe. */
export function splitEnv(
  env: Record<string, string> | undefined,
  keys: string[]
): { picked: Record<string, string>; rest: Record<string, string> } {
  const picked: Record<string, string> = {}
  const rest: Record<string, string> = {}
  for (const [k, v] of Object.entries(env ?? {})) {
    if (keys.includes(k)) picked[k] = v
    else rest[k] = v
  }
  return { picked, rest }
}

/** Inverse of splitEnv — merges the dedicated field values with the remaining env into the final env to store.
 *  Empty-string and undefined values in picked are dropped — that stops a field left blank to mean "not used" from
 *  being stored as env: {KEY: ''}, which would make runManager overwrite the real process.env value with an empty string.
 *  When the same key is also in rest, picked wins — this state really does occur: the user re-typed JAVA_HOME= by hand
 *  into the environment variable textarea while the JDK select still holds a value.
 *  If the hand-written textarea value were stored instead of the value the dedicated field displays, the UI would be
 *  lying — "the field shows one value, the stored value is another". The dedicated field has to win for screen and storage to agree. */
export function mergeEnv(
  picked: Record<string, string | undefined>,
  rest: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { ...rest }
  for (const [k, v] of Object.entries(picked)) {
    if (v) out[k] = v
  }
  return out
}

/** Converts the absolute path returned by RunConfigDialog's working-folder "Choose…" dialog into a path relative to
 *  the project root. run.start resolves RunConfig.cwd against the project root, so storing the absolute path breaks
 *  as soon as the project moves or is opened on another machine.
 *  The prefix comparison ignores case — unlike useFileOps.copyPath(p.slice(root.length)...), whose input comes from
 *  the explorer tree, the input here is whatever the OS folder picker returned, and on win32 the drive letter and path
 *  casing it returns can differ from the project root string (same reasoning as isPathWithin in core/files/tree.ts).
 *  The slice is taken from the original (non-lowercased) string, so the casing of the returned relative path is preserved.
 *  A path outside the project is returned as-is, still absolute — run.saveConfig rejects it at save time. */
export function toRelativeCwd(picked: string, projectPath: string): string {
  const p = picked.toLowerCase()
  const root = projectPath.toLowerCase()
  if (p === root) return ''
  if (p.startsWith(root + '\\') || p.startsWith(root + '/')) {
    return picked.slice(projectPath.length).replace(/^[\\/]/, '')
  }
  return picked
}
