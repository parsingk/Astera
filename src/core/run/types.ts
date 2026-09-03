import type { PackageManager } from './config'

/** The kind of a run configuration. This is the discriminant. */
export type RunConfigType =
  | 'shell'
  | 'npm'
  | 'node'
  | 'gradle'
  | 'maven'
  | 'cargo'
  | 'go'
  | 'python'
  | 'pytest'
  | 'compose'
  | 'dockerfile'
  | 'dotnet'

/** What every kind shares. cwd is relative to the project root — empty means the root */
interface RunConfigBase {
  id: string
  name: string
  cwd?: string
  env?: Record<string, string>
  /** What a second ▶ does while a run of this configuration is live: unset/false restarts it (the
   *  default — a second press must not put a second server on the same port), true starts another run
   *  beside it. Read by decideStart in ./instances, never by RunManager. Not part of seedKeyOf:
   *  flipping it must not change which seed a stored configuration hides. */
  allowMultipleInstances?: boolean
}

/** A free-form command. This is where every pre-type config migrates to, and it is the only way
 *  to run a tool we don't know about, so it stays first-class (IntelliJ has no such kind) */
export interface ShellConfig extends RunConfigBase {
  type: 'shell'
  command: string
}

export interface NpmConfig extends RunConfigBase {
  type: 'npm'
  script: string
  /** 'auto' picks from the lockfile. Defaults to 'auto' so a stored value never goes stale */
  packageManager?: PackageManager | 'auto'
  args?: string
}

export interface NodeConfig extends RunConfigBase {
  type: 'node'
  file: string
  args?: string
  nodePath?: string
}

/** The two JVM kinds. javaHome and springProfiles used to be a UI device for editing keys inside
 *  env — the model had no place for them. Now they are real fields, and runManager turns them back
 *  into env right before it runs */
export interface GradleConfig extends RunConfigBase {
  type: 'gradle'
  tasks: string
  javaHome?: string
  springProfiles?: string
  args?: string
}

export interface MavenConfig extends RunConfigBase {
  type: 'maven'
  goals: string
  javaHome?: string
  springProfiles?: string
  args?: string
}

export interface CargoConfig extends RunConfigBase {
  type: 'cargo'
  subcommand: 'run' | 'test' | 'build'
  release?: boolean
  features?: string
  args?: string
}

export interface GoConfig extends RunConfigBase {
  type: 'go'
  subcommand: 'run' | 'test' | 'build'
  packagePath?: string
  args?: string
}

export interface PythonConfig extends RunConfigBase {
  type: 'python'
  file: string
  interpreter?: string
  args?: string
}

export interface PytestConfig extends RunConfigBase {
  type: 'pytest'
  /** Empty runs the whole suite */
  target?: string
  interpreter?: string
  args?: string
}

/** Unlike the other kinds, nothing here is required: an empty composeFile falls back to whatever
 *  RunContext already found in the project root, and an empty services list means "all services" —
 *  both are meaningful values, not placeholders for a value the user still has to supply. */
export interface ComposeConfig extends RunConfigBase {
  type: 'compose'
  /** Empty uses the file the project context found. Also empty, docker compose finds its own. */
  composeFile?: string
  /** Space-separated service names. Empty means every service. */
  services?: string
  action?: 'up' | 'build'
  args?: string
}

/** Unlike Compose, nothing here reads from RunContext at assembly time — the image tag, Dockerfile
 *  path and both argument strings are all on the config itself, so there is no project-wide fact this
 *  kind needs handed down (no scanner, no context field: see typeIcon.ts and RunConfigManager.tsx for
 *  where "is there a Dockerfile at the root" surfaces instead). */
export interface DockerfileConfig extends RunConfigBase {
  type: 'dockerfile'
  imageTag: string
  dockerfilePath?: string
  buildArgs?: string
  runArgs?: string
}

/** The project file (.csproj/.fsproj/.sln) is required — the .NET CLI would otherwise pick whatever
 *  sits in the working folder, which is a different configuration every time the cwd changes. It is
 *  stored project-relative, like node's `file` and compose's `composeFile`: main/dotnetScanner.ts finds
 *  the candidates and the form's picker converts an absolute pick back down (toRelativeCwd).
 *  subcommand is optional here, unlike cargo/go where it is required: `run` is the only sensible
 *  default for a kind whose project file is already the thing that identifies it. */
export interface DotnetConfig extends RunConfigBase {
  type: 'dotnet'
  project: string
  subcommand?: 'run' | 'test' | 'build'
  /** Debug/Release — free text, since a project can define its own configurations */
  configuration?: string
  args?: string
}

export type RunConfig =
  | ShellConfig
  | NpmConfig
  | NodeConfig
  | GradleConfig
  | MavenConfig
  | CargoConfig
  | GoConfig
  | PythonConfig
  | PytestConfig
  | ComposeConfig
  | DockerfileConfig
  | DotnetConfig

/** The optional field keys a kind knows about. The form's "add optional field" dropdown is built
 *  from this.
 *
 *  This function is the fix for today's defect. Before this, the JDK field had no condition at all,
 *  so a Java version selector was drawn even in a Node project — there was no kind in the model to
 *  condition on. */
export function optionalFieldsFor(type: RunConfigType, opts: { springBoot: boolean }): string[] {
  const common = ['cwd', 'env', 'allowMultipleInstances']
  switch (type) {
    case 'shell':
      return common // args go straight into the command
    case 'npm':
      return ['packageManager', 'args', ...common]
    case 'node':
      return ['nodePath', 'args', ...common]
    case 'gradle':
    case 'maven':
      return ['javaHome', ...(opts.springBoot ? ['springProfiles'] : []), 'args', ...common]
    case 'cargo':
      return ['release', 'features', 'args', ...common]
    case 'go':
      return ['packagePath', 'args', ...common]
    case 'python':
      return ['interpreter', 'args', ...common]
    case 'pytest':
      return ['target', 'interpreter', 'args', ...common]
    case 'compose':
      return ['composeFile', 'services', 'action', 'args', ...common]
    case 'dockerfile':
      return ['dockerfilePath', 'buildArgs', 'runArgs', ...common]
    case 'dotnet':
      return ['subcommand', 'configuration', 'args', ...common]
  }
}

/** What the form's "add optional field" menu still offers: the kind's optional fields, minus the ones
 *  already on screen — added during this editing session (`shown`) or already carrying a value, which
 *  is the same "the value itself is the record" rule the form's own `visible()` uses.
 *
 *  This is optionalFieldsFor's only consumer, and it lives here rather than inline in RunConfigForm
 *  because it is the reachable half of the defect that motivated the kind model (a JDK field drawn in
 *  a Node project): vitest runs with environment: 'node', so the component cannot be rendered, but
 *  this decision can be executed directly. */
export function availableOptionalFields(
  config: RunConfig,
  opts: { springBoot: boolean },
  shown: ReadonlySet<string>
): string[] {
  const values = config as unknown as Record<string, unknown>
  return optionalFieldsFor(config.type, opts).filter((k) => !shown.has(k) && values[k] === undefined)
}
