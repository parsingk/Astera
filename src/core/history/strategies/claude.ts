import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Account, HistoryEntry, ProjectSummary } from '../../types'
import { parseTranscriptMeta, parseTranscriptPreview, parseTranscriptTail } from '../parser'
import type { HistoryIo, HistoryStrategy } from './types'

/** Scan root for claude session files — this file is the only place that knows about `projects` */
const root = (configDir: string): string => path.join(configDir, 'projects')

/** One slug directory → its project row. A directory maps 1:1 to a project here, so this is both the
 *  body of the full listing and what a single file event needs to repair. Sessions are not parsed:
 *  only the newest file's mtime and the real cwd are read. */
const projectSummaryForDir = async (
  account: Account,
  dir: string,
  io: HistoryIo
): Promise<ProjectSummary | null> => {
  const files = await io.jsonlByMtimeDesc(dir)
  if (files.length === 0) return null
  // The real cwd = the cwd of the newest non-helper session. Noise-only folders (no cwd) are skipped.
  const cwd = await io.resolveProjectCwd(
    dir,
    files.map((f) => f.name)
  )
  if (!cwd) return null
  io.cacheDirForProject(account.id, cwd, dir)
  return {
    accountId: account.id,
    projectPath: cwd,
    name: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
    updatedAt: new Date(files[0].mtimeMs).toISOString()
  }
}

/** claude history: <configDir>/projects/<slug>/*.jsonl — directory↔project 1:1 */
export const claudeHistoryStrategy: HistoryStrategy = {
  scanRoot: (account: Account) => root(account.configDir),
  filtersByProject: true,
  allDirs: async (account) => {
    const base = root(account.configDir)
    try {
      return (await fs.readdir(base)).map((s) => path.join(base, s))
    } catch {
      return []
    }
  },
  dirsMatchingProject: async (account, projectPath, io) => {
    // Miss → enumerate, resolve each cwd, and find the matching directory
    // (in the app projectsPage runs first, so this is usually a cache hit)
    const base = root(account.configDir)
    let slugs: string[]
    try {
      slugs = await fs.readdir(base)
    } catch {
      return []
    }
    const matches: string[] = []
    for (const slug of slugs) {
      const dir = path.join(base, slug)
      const files = await io.jsonlByMtimeDesc(dir)
      if (files.length === 0) continue
      const cwd = await io.resolveProjectCwd(dir, files.map((f) => f.name))
      if (cwd && io.samePath(cwd, projectPath)) {
        // Load the cache on every match — the cache keeps the last match and the return value is
        // all of them. That is the existing observable behaviour, so do not "tidy" it into [0]
        io.cacheDirForProject(account.id, projectPath, dir)
        matches.push(dir)
      }
    }
    return matches
  },
  projectSummaryForDir,
  /** Project summary list — one row per slug directory (for claude a directory maps 1:1 to a
   *  project). Sessions are not parsed; built cheaply by reading only the newest file's mtime +
   *  meta (cwd). */
  projectSummaries: async (account, io): Promise<ProjectSummary[]> => {
    const base = root(account.configDir)
    let slugs: string[]
    try {
      slugs = await fs.readdir(base)
    } catch {
      return [] // no projects/ = no history (normal)
    }
    const projects: ProjectSummary[] = []
    for (const slug of slugs) {
      const row = await projectSummaryForDir(account, path.join(base, slug), io)
      if (row) projects.push(row)
    }
    return projects
  },
  /** One transcript file → HistoryEntry. Noise (helper/sidechain) is null. */
  buildEntry: async (account, filePath, mtimeMs): Promise<HistoryEntry | null> => {
    let meta
    try {
      meta = await parseTranscriptMeta(filePath)
    } catch {
      return null
    }
    if (meta.isSidechain || meta.isHelper) return null
    let mtime = mtimeMs
    if (mtime === undefined) {
      try {
        mtime = (await fs.stat(filePath)).mtimeMs
      } catch {
        return null
      }
    }
    const tail = await parseTranscriptTail(filePath)
    const sessionId = meta.sessionId ?? path.basename(filePath, '.jsonl')
    return {
      id: `${account.id}:${sessionId}`,
      accountId: account.id,
      sessionId,
      projectPath: meta.cwd ?? path.basename(path.dirname(filePath)),
      title: tail.lastUserTitle ?? meta.title ?? sessionId,
      updatedAt: new Date(mtime).toISOString(),
      filePath,
      awaitingReply: tail.awaitingReply,
      rootUuid: meta.rootUuid
    }
  },
  /** On an entryById miss — looks for <sessionId>.jsonl in each slug folder of the account's
   *  projects and parses it. It does not load entryById (that is the caller
   *  HistoryIndex.locateEntry's job). */
  locate: async (account, sessionId, io) => {
    const base = claudeHistoryStrategy.scanRoot(account)
    let slugs: string[]
    try {
      slugs = await fs.readdir(base)
    } catch {
      return null
    }
    for (const slug of slugs) {
      const filePath = path.join(base, slug, `${sessionId}.jsonl`)
      try {
        await fs.access(filePath)
      } catch {
        continue
      }
      const entry = await claudeHistoryStrategy.buildEntry(account, filePath, undefined, io)
      if (entry) return entry
    }
    return null
  },
  preview: (filePath) => parseTranscriptPreview(filePath),
  /** The slug folder (the munged cwd) and the filename are determined by cwd and sessionId
   *  regardless of the account, so they are reused as is from the source */
  mapTargetPath: (srcPath, targetConfigDir) =>
    path.join(root(targetConfigDir), path.basename(path.dirname(srcPath)), path.basename(srcPath))
}
