// Project run configurations. Auto-seeded entries for common cases, plus whatever the user adds.
export type { RunConfig, RunConfigType } from './types'
import type { RunConfig } from './types'

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
 *  folder, node's file) into a path relative to the project root. run.start resolves a relative
 *  RunConfig.cwd or file against the project root, so storing the absolute path breaks as soon as the
 *  project moves or is opened on another machine.
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
