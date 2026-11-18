import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Remembered } from '../../core/kube/types'

function isRemembered(v: unknown): v is Remembered {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as { context?: unknown; namespace?: unknown }
  return typeof r.context === 'string' && (r.namespace === null || typeof r.namespace === 'string')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Remembered kube target (context + namespace) per folder, and the chosen overlay per kustomize file.
 *  Keys are opaque strings here. Follows the RunConfigStore pattern. */
export class KubeTargetStore {
  // Maps, not plain objects: keys are opaque and may be 'constructor' or '__proto__'.
  private targets = new Map<string, Remembered>()
  private overlays = new Map<string, string>()
  private writing: Promise<void> = Promise.resolve()

  constructor(private filePath: string) {}

  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (!isRecord(parsed)) throw new Error('invalid schema')
      // A wrong-shaped entry drops only itself; only a file that is not an object is a recovery.
      const targets = new Map<string, Remembered>()
      if (isRecord(parsed.targets)) {
        for (const [k, v] of Object.entries(parsed.targets)) {
          if (isRemembered(v)) targets.set(k, { context: v.context, namespace: v.namespace })
        }
      }
      const overlays = new Map<string, string>()
      if (isRecord(parsed.overlays)) {
        for (const [k, v] of Object.entries(parsed.overlays)) {
          if (typeof v === 'string') overlays.set(k, v)
        }
      }
      this.targets = targets
      this.overlays = overlays
      return { recovered: false }
    } catch (err) {
      this.targets = new Map()
      this.overlays = new Map()
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      return { recovered: true }
    }
  }

  get(key: string): Remembered | undefined {
    return this.targets.get(key)
  }

  async set(key: string, value: Remembered | null): Promise<void> {
    if (value === null) this.targets.delete(key)
    else this.targets.set(key, value)
    await this.persist()
  }

  getOverlay(fileKey: string): string | undefined {
    return this.overlays.get(fileKey)
  }

  async setOverlay(fileKey: string, overlayDir: string | null): Promise<void> {
    if (overlayDir === null) this.overlays.delete(fileKey)
    else this.overlays.set(fileKey, overlayDir)
    await this.persist()
  }

  // Serialised so two quick calls cannot interleave their temp-file writes and renames.
  private persist(): Promise<void> {
    const run = this.writing.then(() => this.write())
    this.writing = run.catch(() => {})
    return run
  }

  private async write(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(
        // fromEntries defines own properties, so a '__proto__' key is written as an ordinary one.
        { targets: Object.fromEntries(this.targets), overlays: Object.fromEntries(this.overlays) },
        null,
        2
      ), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
