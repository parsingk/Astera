import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Account, HistoryEntry, ProjectSummary } from '../../types'
import {
  isExecRollout,
  parseCodexMeta,
  parseCodexPreview,
  parseCodexTail,
  ROLLOUT_UUID_RE
} from '../codexParser'
import type { HistoryStrategy } from './types'

/** Scan root for codex session files — this file is the only place that knows about `sessions` */
const root = (configDir: string): string => path.join(configDir, 'sessions')

/** codex history: <configDir>/sessions/<y>/<m>/<d>/rollout-<ts>-<uuid>.jsonl — directory↔date 1:1 */
export const codexHistoryStrategy: HistoryStrategy = {
  scanRoot: (account: Account) => root(account.configDir),
  // Directories are dates, so a directory cannot be filtered by projectPath — the caller filters per entry
  filtersByProject: false,
  allDirs: async (account, io) => {
    const out: string[] = []
    for (const y of await io.subdirs(root(account.configDir)))
      for (const m of await io.subdirs(y)) out.push(...(await io.subdirs(m)))
    return out
  },
  // Not called, because filtersByProject=false. So that a call breaking the contract is not let
  // through silently, it returns the same result as allDirs — too wide is safer than a truncated list
  dirsMatchingProject: (account, _projectPath, io) => codexHistoryStrategy.allDirs(account, io),
  /** Project summary list — for codex the folder is a date, so it is one row per cwd rather than one
   *  row per folder, and the cwd can only be read from inside the file. Grouped by cwd (among the
   *  same cwd, the newest updatedAt represents them). Map keys are normalized with io.pathKey.
   *
   *  This used to call io.parseDir, which builds a full HistoryEntry per file — a head parse *and* a
   *  256KB tail read (the tail was 39% of the cost, measured). A summary needs neither the title nor
   *  awaitingReply, so only the head is read here, and io.cwdMemo keeps even that from being repeated
   *  across restarts. The session list is built when a project is expanded, as it already is for claude.
   *
   *  The exclusion rule stays "no cwd = not a project", the same one buildEntry applies. */
  projectSummaries: async (account, io): Promise<ProjectSummary[]> => {
    const files: { path: string; mtimeMs: number; size: number }[] = []
    for (const dir of await codexHistoryStrategy.allDirs(account, io)) {
      for (const f of await io.jsonlByMtimeDesc(dir)) {
        files.push({ path: path.join(dir, f.name), mtimeMs: f.mtimeMs, size: f.size })
      }
    }
    // An exec rollout reports no cwd here, which is the same thing this list already says about a
    // file it does not recognise — "no cwd = not a project", the rule buildEntry applies too. That
    // keeps the exclusion in one shape rather than adding a second kind of skip.
    const cwds = await io.cwdMemo(files, async (p) => {
      const m = await parseCodexMeta(p)
      return isExecRollout(m) ? null : m.cwd
    })
    const byPath = new Map<string, ProjectSummary>()
    files.forEach((f, i) => {
      const cwd = cwds[i]
      if (!cwd) return
      const key = io.pathKey(cwd)
      const updatedAt = new Date(f.mtimeMs).toISOString()
      const cur = byPath.get(key)
      if (!cur || updatedAt > cur.updatedAt) {
        byPath.set(key, {
          accountId: account.id,
          projectPath: cwd,
          name: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
          updatedAt
        })
      }
    })
    return [...byPath.values()]
  },
  /** One codex rollout file → HistoryEntry. Treated as noise and null when cwd or sessionId is missing. */
  buildEntry: async (account, filePath, mtimeMs): Promise<HistoryEntry | null> => {
    let meta
    try {
      meta = await parseCodexMeta(filePath)
    } catch {
      return null
    }
    if (!meta.cwd) return null
    // This app's own explanation runs are not the user's conversations — they should not appear in a
    // list of sessions to resume (see isExecRollout).
    if (isExecRollout(meta)) return null
    const sessionId = meta.sessionId ?? filePath.match(ROLLOUT_UUID_RE)?.[1] ?? null
    if (!sessionId) return null
    let mtime = mtimeMs
    if (mtime === undefined) {
      try {
        mtime = (await fs.stat(filePath)).mtimeMs
      } catch {
        return null
      }
    }
    const tail = await parseCodexTail(filePath)
    return {
      id: `${account.id}:${sessionId}`,
      accountId: account.id,
      sessionId,
      projectPath: meta.cwd,
      title: tail.lastUserTitle ?? meta.title ?? sessionId,
      updatedAt: new Date(mtime).toISOString(),
      filePath,
      awaitingReply: tail.awaitingReply,
      rootUuid: null // codex has no resume-fork concept, so it is not a groupForks candidate
    }
  },
  /** On an entryById miss — walks the codex date folders looking for the <sessionId>.jsonl suffix and
   *  parses it. The filename is rollout-<ts>-<uuid>.jsonl, so a path cannot be assembled directly
   *  from sessionId. It does not load entryById (that is the caller HistoryIndex.locateEntry's job). */
  locate: async (account, sessionId, io) => {
    for (const dir of await codexHistoryStrategy.allDirs(account, io)) {
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      const hit = names.find((n) => n.endsWith(`${sessionId}.jsonl`))
      if (!hit) continue
      const entry = await codexHistoryStrategy.buildEntry(account, path.join(dir, hit), undefined, io)
      if (entry) return entry
    }
    return null
  },
  preview: (filePath) => parseCodexPreview(filePath),
  /** The three date folder levels (YYYY/MM/DD) and the filename are determined by the session, so
   *  they are reused as is from the source */
  mapTargetPath: (srcPath, targetConfigDir) => {
    const day = path.dirname(srcPath)
    const month = path.dirname(day)
    const year = path.dirname(month)
    return path.join(
      root(targetConfigDir),
      path.basename(year),
      path.basename(month),
      path.basename(day),
      path.basename(srcPath)
    )
  }
}
