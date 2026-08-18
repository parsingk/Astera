// Run configurations, everything except the model itself: the seeds derived from a project's files,
// the identity rule that decides when a stored configuration hides a seed, and the small conversions
// the form needs (environment text, project-relative paths). The RunConfig union and its per-kind
// interfaces live in ./types and are only re-exported here, so a renderer module that needs both
// still has one import.
export type { RunConfig, RunConfigType } from './types'
import type { RunConfig, RunConfigType } from './types'

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
 * These come out typed, not as command strings — buildCommand assembles the actual command from the type and a
 * RunContext at run time, so platform-specific detail like the Gradle/Maven wrapper choice lives there, not here.
 */
export function detectSeedConfigs(
  files: string[],
  texts: { packageJson: string | null; buildGradle: string | null; pom: string | null }
): RunConfig[] {
  const set = new Set(files)
  const out: RunConfig[] = []
  if (set.has('package.json') && texts.packageJson) {
    let scripts: Record<string, unknown> | undefined
    try {
      const parsed = JSON.parse(texts.packageJson)
      if (parsed && typeof parsed === 'object') scripts = parsed.scripts
    } catch {
      /* Ignore a malformed package.json */
    }
    if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
      for (const key of Object.keys(scripts)) {
        out.push({ id: `seed:npm:${key}`, name: key, type: 'npm', script: key })
      }
    }
  }
  if (set.has('Cargo.toml'))
    out.push({ id: 'seed:cargo:run', name: 'cargo run', type: 'cargo', subcommand: 'run' })
  if (set.has('go.mod')) out.push({ id: 'seed:go:run', name: 'go run .', type: 'go', subcommand: 'run' })

  if (set.has('build.gradle') || set.has('build.gradle.kts')) {
    // Limitation: in a multi-module Gradle build the Boot plugin may live only in a subproject, so when the root
    // body does not mention it only build/test get seeded. Those configs still work, so this stays as an acceptable heuristic.
    const isBoot = !!texts.buildGradle && texts.buildGradle.includes(SPRING_BOOT_MARKER)
    for (const task of isBoot ? ['bootRun', 'test', 'build'] : ['build', 'test']) {
      out.push({ id: `seed:gradle:${task}`, name: task, type: 'gradle', tasks: task })
    }
  }

  if (set.has('pom.xml')) {
    const isBoot = !!texts.pom && texts.pom.includes(SPRING_BOOT_MARKER)
    for (const goal of isBoot ? ['spring-boot:run', 'test', 'package'] : ['package', 'test']) {
      out.push({ id: `seed:maven:${goal}`, name: goal, type: 'maven', goals: goal })
    }
  }

  return out
}

/** Whether the project is Spring Boot — true when a build file body contains SPRING_BOOT_MARKER. Separate from the
 *  per-build-system checks detectSeedConfigs makes locally, this exposes a project-level verdict for run.list to use
 *  when deciding whether the configuration form offers the Spring profile field (optionalFieldsFor in ./types,
 *  reached through RunConfigManager's isSpringBoot prop; buried inside that logic it could not be reused).
 *  The two isBoot checks inside detectSeedConfigs (local, per build system) are left alone — in the rare case both
 *  Gradle and Maven sit at the root, detectSeedConfigs may seed in a different order than this function reports, but
 *  those were always independent checks, so unifying them here would change the existing seed behaviour. */
export function isSpringBootProject(texts: { buildGradle: string | null; pom: string | null }): boolean {
  return (
    (!!texts.buildGradle && texts.buildGradle.includes(SPRING_BOOT_MARKER)) ||
    (!!texts.pom && texts.pom.includes(SPRING_BOOT_MARKER))
  )
}

/** Whether the project root has a Dockerfile — the run type picker's detection signal for
 *  'dockerfile'. Unlike python/pytest (hasPythonProject in core/run/python.ts) there is no scanner and
 *  no dedicated project-type concept: ipc.ts's run.list already reads the root file list for every
 *  other seed, so this fact is already in hand and only needs a name to travel under. It is not part of
 *  RunContext (unlike composeFile) because nothing in buildCommand's 'dockerfile' case reads context —
 *  imageTag, dockerfilePath and both argument strings all live on the config itself, so there is no
 *  assembly-time reason for this to double as anything beyond a detection flag. */
export function hasDockerfile(files: string[]): boolean {
  return files.includes('Dockerfile')
}

/** The project file a new dotnet configuration starts on, out of what main/dotnetScanner.ts found.
 *
 *  Not simply the first entry. The scanner sorts alphabetically, so a repository with a root solution
 *  file usually lists the .sln first — and a new configuration's subcommand defaults to `run`, which
 *  refuses one ("'App.sln' is not a valid project file", checked against the installed .NET 9 SDK). So
 *  an actual project file wins whenever the scan found one.
 *
 *  This is deliberately a rule about the *default*, not about the order: `dotnet test` and
 *  `dotnet build` both accept a solution, so the .sln stays where the scanner put it in the form's
 *  Select and a user who wants it can still pick it.
 *
 *  Falls back to the first entry, and then to '': a repository may genuinely hold only a solution
 *  file, and a configuration pointing at one beats a configuration pointing at nothing. */
export function defaultDotnetProject(projects: string[]): string {
  return projects.find((p) => /\.(cs|fs)proj$/i.test(p)) ?? projects[0] ?? ''
}

/** The identity of a config — its type plus the core parameter that makes it what it is.
 *
 *  This used to be the assembled command. Now that the command is a derived value, comparing by it would make a
 *  seed collide or stop colliding whenever the lockfile (npm) or wrapper (Gradle/Maven) changes, even though the
 *  configuration itself did not. */
export function seedKeyOf(c: RunConfig): string {
  switch (c.type) {
    case 'shell':
      return `shell:${c.command}`
    case 'npm':
      return `npm:${c.script}`
    case 'node':
      return `node:${c.file}`
    case 'gradle':
      return `gradle:${c.tasks}`
    case 'maven':
      return `maven:${c.goals}`
    case 'cargo':
      return `cargo:${c.subcommand}`
    case 'go':
      return `go:${c.subcommand}:${c.packagePath ?? '.'}`
    case 'python':
      return `python:${c.file}`
    case 'pytest':
      return `pytest:${c.target ?? ''}`
    case 'compose':
      return `compose:${c.composeFile ?? ''}:${c.services ?? ''}`
    case 'dockerfile':
      return `dockerfile:${c.imageTag}`
    case 'dotnet':
      return `dotnet:${c.project}:${c.subcommand ?? 'run'}`
  }
}

/** Display list = stored configs + seeds whose identity does not collide. Stored (user) configs come first. */
export function mergeConfigs(seed: RunConfig[], stored: RunConfig[]): RunConfig[] {
  const taken = new Set(stored.map(seedKeyOf))
  return [...stored, ...seed.filter((s) => !taken.has(seedKeyOf(s)))]
}

/** Promotes an auto-detected configuration into a user configuration.
 *
 *  IntelliJ shows the temporary configuration created by running from the gutter in italics, and
 *  saving it turns it into a permanent one. Our seeds are the same kind of thing, so they follow the
 *  same rule rather than inventing a new concept. mergeConfigs already settles conflicts by
 *  seedKeyOf, so the promoted copy automatically hides the original seed once it is stored — there is
 *  no second suppression to add here. */
export function promoteSeed(config: RunConfig, newId: string): RunConfig {
  return { ...config, id: newId }
}

/** A new configuration's starting values for a kind, right after it is picked in RunTypePicker.
 *
 *  No kind may be born holding a *seed's* identity. mergeConfigs hides a seed the moment a stored
 *  configuration shares its seedKeyOf, and ＋ stores the new configuration immediately (run.saveConfig,
 *  see migrateRunConfigs' allowIncomplete), so a starting value that matches a detected configuration
 *  takes that row out of the list as soon as the kind is picked — before anything has been typed, and
 *  with no way to cancel. Three kinds could: npm started on the project's first script, and cargo and
 *  go on `run`, which is exactly what detectSeedConfigs seeds for them. Each of those now starts on the
 *  first candidate no seed has claimed. Only seeds are looked at, because only they can be hidden:
 *  mergeConfigs filters the seed side alone, so two stored configurations sharing an identity both stay
 *  on screen.
 *
 *  npm falls back to an empty script when every candidate is seeded — which is the usual case, since
 *  every package.json script gets a seed. An empty required field is a value this app stores now, and
 *  run.start is what refuses to run it; the form's Select draws its own "not selected" placeholder for
 *  it, so this needs no copy of its own. cargo/go have no such fallback to reach — their subcommand is
 *  a three-value union with no empty member — but detectSeedConfigs only ever seeds `run`, so a free
 *  candidate always exists and the fallback below is the unreachable arm.
 *
 *  dotnet keeps the scanned default it was given — defaultDotnetProject rather than [0], since the
 *  first entry is often a .sln and the subcommand this starts on (`run`) rejects one. Nothing can be
 *  displaced there: .NET has no seed configurations. */
export function defaultConfigFor(
  type: RunConfigType,
  id: string,
  name: string,
  /** The configurations on screen — only the seeds among them matter, see above */
  existing: RunConfig[],
  /** Script names already known for this project — the npm Select's candidate list */
  npmScripts: string[],
  dotnetProjects: string[]
): RunConfig {
  const seeded = new Set(existing.filter((c) => c.id.startsWith('seed:')).map(seedKeyOf))
  // Candidates are compared through seedKeyOf itself rather than by spelling its key strings out a
  // second time here, so a change to the identity rule cannot drift out from under this.
  const firstFree = (candidates: RunConfig[], fallback: RunConfig): RunConfig =>
    candidates.find((c) => !seeded.has(seedKeyOf(c))) ?? fallback
  const SUBCOMMANDS = ['run', 'test', 'build'] as const
  switch (type) {
    case 'shell':
      return { id, name, type, command: '' }
    case 'npm': {
      const candidates: RunConfig[] = npmScripts.map((script) => ({ id, name, type: 'npm', script }))
      return firstFree(candidates, { id, name, type: 'npm', script: '' })
    }
    case 'node':
      return { id, name, type, file: '' }
    case 'gradle':
      return { id, name, type, tasks: '' }
    case 'maven':
      return { id, name, type, goals: '' }
    case 'cargo': {
      const candidates: RunConfig[] = SUBCOMMANDS.map((subcommand) => ({ id, name, type: 'cargo', subcommand }))
      return firstFree(candidates, { id, name, type: 'cargo', subcommand: 'run' })
    }
    case 'go': {
      const candidates: RunConfig[] = SUBCOMMANDS.map((subcommand) => ({ id, name, type: 'go', subcommand }))
      return firstFree(candidates, { id, name, type: 'go', subcommand: 'run' })
    }
    case 'python':
      return { id, name, type, file: '' }
    case 'pytest':
      return { id, name, type }
    case 'compose':
      return { id, name, type }
    case 'dockerfile':
      return { id, name, type, imageTag: '' }
    case 'dotnet':
      return { id, name, type, project: defaultDotnetProject(dotnetProjects) }
  }
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

/** Converts the absolute path returned by one of RunConfigForm's "Choose…"/"찾기" dialogs (working
 *  folder, node's file, and the rest) into a path relative to the project root. Every stored path
 *  field is project-relative for the same reason: an absolute path breaks as soon as the project
 *  moves or is opened on another machine.
 *
 *  How those relative paths are resolved differs by field, and only `cwd` is resolved here in the app:
 *  run.start passes it through resolveRunCwd (main/run/prepare.ts), which resolves it against the project root and
 *  hands the result to the PTY. Every other path field is spliced into the command text untouched and
 *  is therefore resolved by the invoked tool against **the working folder**, not the project root — so
 *  the two only coincide while the working folder is the project root (which is the default: an empty
 *  cwd means the root). Set a cwd and a project-relative `file` resolves one level too deep. Rewriting
 *  those paths at assembly time would be the more surprising rule — a tool resolving its arguments
 *  against its own working directory is what every shell already does — so the mismatch is recorded
 *  here rather than papered over.
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
