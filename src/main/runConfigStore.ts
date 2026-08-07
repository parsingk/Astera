import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RunConfig } from '../core/run/config'

// env is an optional field — existing configs without it must stay valid. The stored file can be hand-edited and its
// values flow straight through runManager into the PTY process env, so when a value is not a string (number, object,
// array, ...) the whole config is rejected instead of breaking silently.
function isValidEnv(v: unknown): v is Record<string, string> | undefined {
  if (v === undefined) return true
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v).every((val) => typeof val === 'string')
}

// cwd is optional too. For the same reason as env, only the type is checked — semantic verdicts such as whether it
// is inside an allowed root or inside the project are made by run.start right before it runs (ipc.ts). Rejecting even
// the empty string here would let one harmless hand-edit turn the whole store into a schema violation and get it
// thrown away (load recovers to {}), so this stops at a type check.
function isValidCwd(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string'
}

function isValidConfig(v: unknown): v is RunConfig {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.command === 'string' &&
    isValidEnv(o.env) &&
    isValidCwd(o.cwd)
  )
}

function isValidMap(obj: unknown): obj is Record<string, RunConfig[]> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false
  return Object.values(obj).every((v) => Array.isArray(v) && v.every(isValidConfig))
}

/** Per-project user run config store. Key = project root path. Follows the RollConfigStore pattern. */
export class RunConfigStore {
  private map: Record<string, RunConfig[]> = {}

  constructor(private filePath: string) {}

  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (!isValidMap(parsed)) throw new Error('invalid schema')
      this.map = parsed
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.map = {}
        return { recovered: false }
      }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.map = {}
      return { recovered: true }
    }
  }

  get(projectPath: string): RunConfig[] {
    return this.map[projectPath] ?? []
  }

  async save(projectPath: string, configs: RunConfig[]): Promise<void> {
    this.map[projectPath] = configs
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.map, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
