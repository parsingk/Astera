import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Persistence for user keybinding settings. The defaults live in code (core/keys/binding.ts) and this file holds
 * **only the overridden actions** — when a default changes, actions the user never touched follow the new default.
 *
 * Why this is not merged into app-settings.json: the schema grows with the number of actions, and this can become a
 * file users open and edit themselves, so it is better to keep the blast radius of a corrupt file narrow.
 */
export type KeybindingOverrides = Record<string, string[]>

function sanitize(parsed: unknown): KeybindingOverrides {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid schema')
  }
  const out: KeybindingOverrides = {}
  for (const [actionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    // One odd entry does not throw away the whole file — the remaining settings survive
    if (!Array.isArray(value)) continue
    if (!value.every((v) => typeof v === 'string')) continue
    out[actionId] = value as string[]
  }
  return out
}

export class KeybindingsStore {
  private overrides: KeybindingOverrides = {}

  constructor(private filePath: string) {}

  async load(): Promise<{ recovered: boolean }> {
    try {
      this.overrides = sanitize(JSON.parse(await fs.readFile(this.filePath, 'utf8')))
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.overrides = {}
        return { recovered: false }
      }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.overrides = {}
      return { recovered: true }
    }
  }

  get(): KeybindingOverrides {
    return { ...this.overrides }
  }

  async set(actionId: string, keys: string[]): Promise<void> {
    this.overrides = { ...this.overrides, [actionId]: [...keys] }
    await this.persist()
  }

  /** With an actionId, resets just that action; without one, resets everything to the defaults. */
  async reset(actionId?: string): Promise<void> {
    if (actionId === undefined) this.overrides = {}
    else {
      const { [actionId]: _dropped, ...rest } = this.overrides
      this.overrides = rest
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.overrides, null, 2), 'utf8')
  }
}
