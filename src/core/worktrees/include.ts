import { promises as fs } from 'node:fs'
import path from 'node:path'
import { git } from './git'
import type { Message } from '../i18n'

export const INCLUDE_FILE = '.worktreeinclude'
const MAX_FILE_BYTES = 256 * 1024
const MAX_ENTRIES = 1000
const MAX_COPY_TOTAL_BYTES = 200 * 1024 * 1024

/** Only literal paths are allowed. globs, negations, absolute paths, .. and .git are warned about and skipped. */
export function parseWorktreeInclude(content: string): { entries: string[]; warnings: Message[] } {
  const entries: string[] = []
  const warnings: Message[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (entries.length >= MAX_ENTRIES) {
      warnings.push({ key: 'worktree.include.tooManyEntries', params: { max: MAX_ENTRIES } })
      break
    }
    if (line.includes('*') || line.includes('?') || line.startsWith('!')) {
      warnings.push({ key: 'worktree.include.globUnsupported', params: { line } })
      continue
    }
    const norm = line.replace(/\\/g, '/')
    if (path.isAbsolute(line) || /^[A-Za-z]:/.test(line)) {
      warnings.push({ key: 'worktree.include.absolutePath', params: { line } })
      continue
    }
    const segs = norm.split('/')
    if (segs.includes('..')) {
      warnings.push({ key: 'worktree.include.parentPath', params: { line } })
      continue
    }
    if (segs.includes('.git')) {
      warnings.push({ key: 'worktree.include.gitDir', params: { line } })
      continue
    }
    entries.push(norm.replace(/\/+$/, ''))
  }
  return { entries, warnings }
}

/** Counts the bytes fs.cp(dereference:true) will actually write — by dirent a symlink is neither a
 *  file nor a directory, so its target has to be stat'ed separately. A broken link counts as 0.
 *  So that a symlink cycle pointing at a directory (common in pnpm-style node_modules) is not
 *  re-entered, visits are tracked by realpath identity rather than by name — the Set is threaded
 *  through the recursive calls as an argument instead of being module-global state (which keeps
 *  concurrent calls from interfering with each other). */
export async function dirSize(p: string, visited: Set<string> = new Set()): Promise<number> {
  let real: string
  try {
    real = await fs.realpath(p) // cycle detection goes by the real target, not by the path string
  } catch {
    return 0 // 0 whenever the target cannot be resolved — broken link, permission denied, and so on
  }
  if (visited.has(real)) return 0 // re-entering a directory already visited — cycle blocked
  visited.add(real)
  let total = 0
  const entries = await fs.readdir(p, { withFileTypes: true })
  for (const e of entries) {
    const child = path.join(p, e.name)
    if (e.isDirectory()) total += await dirSize(child, visited)
    else if (e.isFile()) total += (await fs.stat(child)).size
    else {
      try {
        const stat = await fs.stat(child) // symlinks and the like — by the real target (follow)
        total += stat.isDirectory() ? await dirSize(child, visited) : stat.size
      } catch {
        // broken symlink — it is not copied, so its size is 0 as well
      }
    }
  }
  return total
}

/** Copies only the repo's .worktreeinclude entries that exist and are gitignored into the worktree. Returns the warning list. */
export async function copyWorktreeInclude(repoPath: string, worktreePath: string): Promise<Message[]> {
  const file = path.join(repoPath, INCLUDE_FILE)
  let content: string
  try {
    const stat = await fs.stat(file)
    if (stat.size > MAX_FILE_BYTES)
      return [{ key: 'worktree.include.fileTooLarge', params: { max: MAX_FILE_BYTES } }]
    content = await fs.readFile(file, 'utf8')
  } catch {
    return [] // no file = the convention is not in use
  }
  const { entries, warnings } = parseWorktreeInclude(content)
  let budget = MAX_COPY_TOTAL_BYTES
  for (const entry of entries) {
    const src = path.join(repoPath, entry)
    let stat
    try {
      stat = await fs.stat(src) // a symlink goes by its real target
    } catch {
      warnings.push({ key: 'worktree.include.missing', params: { entry } })
      continue
    }
    // copying a tracked file would overwrite what checkout produced, so only gitignored entries
    const ignored = (await git(['check-ignore', '-q', entry], { cwd: repoPath })).ok
    if (!ignored) {
      warnings.push({ key: 'worktree.include.notIgnored', params: { entry } })
      continue
    }
    let size: number
    try {
      size = stat.isDirectory() ? await dirSize(src) : stat.size
    } catch (err) {
      // a failure while measuring size (permission denied, deletion during the scan and other races) must not block creation itself
      warnings.push({
        key: 'worktree.include.sizeFailed',
        params: { entry, detail: err instanceof Error ? err.message : String(err) }
      })
      continue
    }
    if (size > budget) {
      warnings.push({ key: 'worktree.include.overLimit', params: { entry } })
      continue
    }
    budget -= size
    const dest = path.join(worktreePath, entry)
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.cp(src, dest, { recursive: true, dereference: true })
    } catch (err) {
      warnings.push({
        key: 'worktree.include.copyFailed',
        params: { entry, detail: err instanceof Error ? err.message : String(err) }
      })
    }
  }
  return warnings
}
