import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorktreeInfo } from '../types'

interface RegistryFile {
  root?: string
  items: WorktreeInfo[]
}

function isValidFile(obj: unknown): obj is RegistryFile {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false
  const f = obj as Record<string, unknown>
  if (f.root !== undefined && typeof f.root !== 'string') return false
  if (!Array.isArray(f.items)) return false
  return f.items.every(
    (w) =>
      w !== null &&
      typeof w === 'object' &&
      ['id', 'repoPath', 'path', 'name', 'branch', 'baseRef', 'createdAt'].every(
        (k) => typeof (w as Record<string, unknown>)[k] === 'string'
      )
  )
}

/** Persistent registry of the worktrees the app created — being listed here is what authorizes deletion. */
export class WorktreeRegistry {
  private root: string | null = null
  private items: WorktreeInfo[] = []

  constructor(
    private filePath: string,
    private defaultRoot: string
  ) {}

  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (!isValidFile(parsed)) throw new Error('invalid schema')
      // an empty root falls back to the default — matches setRoot's invariant
      this.root = parsed.root && parsed.root.trim() !== '' ? parsed.root : null
      this.items = parsed.items
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.root = null
      this.items = []
      return { recovered: true }
    }
  }

  list(): WorktreeInfo[] {
    return [...this.items]
  }

  get(id: string): WorktreeInfo | null {
    return this.items.find((w) => w.id === id) ?? null
  }

  async add(info: WorktreeInfo): Promise<void> {
    this.items = [...this.items, info]
    await this.save()
  }

  async removeEntry(id: string): Promise<void> {
    this.items = this.items.filter((w) => w.id !== id)
    await this.save()
  }

  getRoot(): string {
    return this.root ?? this.defaultRoot
  }

  async setRoot(root: string | null): Promise<void> {
    this.root = root && root.trim() !== '' ? root : null
    await this.save()
  }

  private async save(): Promise<void> {
    const file: RegistryFile = { ...(this.root ? { root: this.root } : {}), items: this.items }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    // atomic write (tmp+rename) — prevents a torn write (same pattern as AccountRegistry.save)
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
