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

/** What every kind shares. cwd is relative to the project root — empty means the root */
interface RunConfigBase {
  id: string
  name: string
  cwd?: string
  env?: Record<string, string>
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

/** The optional field keys a kind knows about. The form's "add optional field" dropdown is built
 *  from this.
 *
 *  This function is the fix for today's defect. Before this, the JDK field had no condition at all,
 *  so a Java version selector was drawn even in a Node project — there was no kind in the model to
 *  condition on. */
export function optionalFieldsFor(type: RunConfigType, opts: { springBoot: boolean }): string[] {
  const common = ['cwd', 'env']
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
  }
}
