import { detectPackageManager, type PackageManager } from './config'
import type { RunConfig } from './types'
import { COMPOSE_FILE_NAMES } from './compose'

/** The context command assembly needs. Derived from the file list and platform, never stored */
export interface RunContext {
  packageManager: PackageManager
  /** 'gradlew.bat' | './gradlew' | 'gradle' — platform and wrapper presence are already baked in */
  gradleRunner: string
  mavenRunner: string
  composeFile: string | null
  /** Needed because quoting rules differ per shell. Only ever compared against 'win32', so string —
   *  this module is registered in tsconfig.web.json, which has no NodeJS globals */
  platform: string
}

// Characters cmd.exe interprets even inside double quotes. Assembly cannot guard against these
const UNSAFE_WIN32 = /[&|^%!<>]/

/** Whether a value has a character cmd.exe's quoting lets through unquoted. Used to reject at save
 *  time — better than silently building a broken command */
export function hasUnsafeWin32Chars(value: string): boolean {
  return UNSAFE_WIN32.test(value)
}

/** Quotes a single value for the target shell. shell-kind configs never go through this — the user
 *  writes shell syntax directly there */
export function quoteArg(value: string, platform: string): string {
  if (value === '') return platform === 'win32' ? '""' : "''"
  if (!/[\s"'`$&|<>^%!()]/.test(value)) return value
  if (platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  // sh: everything inside single quotes is literal. Only a single quote in the value needs splicing
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Joins only the parts that have a value, with a single space */
const join = (...parts: (string | null | undefined | false)[]): string =>
  parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')

/** Builds the command to run from a configuration's kind and parameters.
 *  **The form's preview calls this too** — keeping the rule in one place is the point. */
export function buildCommand(config: RunConfig, ctx: RunContext): string {
  const q = (v: string): string => quoteArg(v, ctx.platform)
  switch (config.type) {
    case 'shell':
      return config.command
    case 'npm': {
      const pm =
        !config.packageManager || config.packageManager === 'auto'
          ? ctx.packageManager
          : config.packageManager
      return join(pm, 'run', config.script, config.args)
    }
    case 'node':
      return join(config.nodePath ? q(config.nodePath) : 'node', q(config.file), config.args)
    case 'gradle':
      return join(ctx.gradleRunner, config.tasks, config.args)
    case 'maven':
      return join(ctx.mavenRunner, config.goals, config.args)
    case 'cargo':
      return join(
        'cargo',
        config.subcommand,
        config.release ? '--release' : '',
        config.features ? `--features ${q(config.features)}` : '',
        config.args
      )
    case 'go':
      // packagePath 는 단일 값이므로 인용한다 — args·tasks·goals 처럼 여러 토큰을 담는 필드가 아니다.
      // quoteArg 는 특수문자가 없으면 그대로 돌려주므로 './...' 같은 흔한 값은 모양이 바뀌지 않는다
      return join('go', config.subcommand, q(config.packagePath || '.'), config.args)
    case 'python':
      return join(q(config.interpreter || 'python'), q(config.file), config.args)
    case 'pytest':
      return join(q(config.interpreter || 'python'), '-m pytest', config.target ? q(config.target) : '', config.args)
    case 'compose': {
      const file = config.composeFile || ctx.composeFile
      return join('docker compose', file ? `-f ${q(file)}` : '', config.action ?? 'up', config.services, config.args)
    }
  }
}

/** Builds the assembly context from the file list and platform.
 *
 *  The wrapper choice lives here. posix runs via sh -c, which only searches PATH, so a bare `gradlew`
 *  is never found — it has to be `./gradlew`. win32 runs via cmd.exe /c, which checks the current
 *  directory first, so `gradlew.bat` alone is enough. No wrapper falls back to the global command. */
export function buildRunContext(files: string[], platform: string): RunContext {
  const set = new Set(files)
  const win = platform === 'win32'
  return {
    packageManager: detectPackageManager(files),
    gradleRunner: win ? (set.has('gradlew.bat') ? 'gradlew.bat' : 'gradle') : set.has('gradlew') ? './gradlew' : 'gradle',
    mavenRunner: win ? (set.has('mvnw.cmd') ? 'mvnw.cmd' : 'mvn') : set.has('mvnw') ? './mvnw' : 'mvn',
    // Priority order, same as docker compose's own search — the first name present in the project root wins
    composeFile: COMPOSE_FILE_NAMES.find((name) => set.has(name)) ?? null,
    platform
  }
}
