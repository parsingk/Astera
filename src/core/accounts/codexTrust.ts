// Pre-marking a folder as trusted for codex, so the agent's "Do you trust this folder?" menu does
// not fire on a worker nobody is sitting in front of.
//
// **Why this exists even though the worker already gets the bypass flag.** The two are different
// questions: `--dangerously-bypass-approvals-and-sandbox` sets the approval and sandbox policy, and
// trust is whether codex will load the project at all. Measured on this machine: a Job worker in a
// fresh worktree stopped at the trust menu, and once it was answered nothing else asked for anything.
// So the trust menu is the whole remaining wall, and the bypass flag does not take it down.
// (Orca reached the same conclusion against the Codex CLI source — src/main/agent-trust-presets.ts:
// "Codex's --dangerously-bypass-approvals-and-sandbox would also change approval/sandbox policy, so
// it is not equivalent to 'trust this project'.")
//
// **Why the app writes the file instead of answering the menu.** Answering means recognising a
// screen and typing into it, which is what the rolling coordinator does for its own respawn window
// (rolling.ts's trustSeen) and it is the fragile half of that code — a menu whose wording changes
// leaves no trace of why nothing happened. The file is the same artifact codex writes itself once a
// person accepts, so pre-writing it is indistinguishable from having accepted.
//
// There is no claude counterpart here on purpose: `--dangerously-skip-permissions` covers claude's
// trust prompt as well, which is why Orca's preset module has no claude entry either.
import { promises as fs } from 'node:fs'
import path from 'node:path'

export type CodexTrustLevel = 'trusted' | 'untrusted'

/** TOML basic-string escaping for the one value this module writes — a filesystem path. Windows
 *  separators are the reason this is not optional: `D:\p\x` inside `"` is a string with a `\p`
 *  escape codex would reject. */
function escapeTomlBasicString(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The comparison key for "is this the same project". Case- and separator-insensitive because the
 *  same folder reaches us spelled differently all the time on win32 (`D:\P\A` from a picker,
 *  `d:/p/a` from a git command), and two blocks for one folder is a file whose meaning depends on
 *  which one codex reads last. */
function trustKey(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** The path inside `[projects."…"]`, or null when the line is not such a header. */
function projectHeaderPath(line: string): string | null {
  const m = /^\s*\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*(?:#.*)?$/.exec(line)
  if (!m) return null
  // Only the basic-string form carries escapes; the literal-string form is taken as written.
  return m[1] !== undefined ? m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"') : (m[2] ?? null)
}

/** Whether the scanner is outside a multi-line string, i.e. whether this line's text is structure.
 *  Without this a `[projects."…"]` sitting inside someone's `"""…"""` block reads as a table header
 *  and the edit lands in the middle of their prose. */
function togglesMultiline(line: string, open: '"""' | "'''" | null): '"""' | "'''" | null {
  let state = open
  for (let i = 0; i < line.length; i++) {
    const three = line.slice(i, i + 3)
    if (state === null && (three === '"""' || three === "'''")) {
      state = three
      i += 2
    } else if (state !== null && three === state) {
      state = null
      i += 2
    }
  }
  return state
}

/**
 * Returns `existing` with `projectPath` marked at `level`, leaving everything else byte-identical.
 *
 * Three shapes, in the order they are tried: the project already has a block with a trust_level (the
 * value is rewritten in place), it has a block without one (the key is inserted at the top of that
 * block), or it has no block (one is appended). Hand-rolled rather than parsed and re-serialised
 * because this project has no TOML parser and config.toml is the user's file — codex keeps its
 * settings and MCP servers in it (see syncCodexSettings), so a round-trip through a parser would
 * reformat, reorder and drop comments from a file we were only asked to add two lines to.
 */
export function upsertProjectTrust(
  existing: string,
  projectPath: string,
  level: CodexTrustLevel = 'trusted'
): string {
  const content = existing.charCodeAt(0) === 0xfeff ? existing.slice(1) : existing
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const trustLine = `trust_level = "${level}"`
  const want = trustKey(projectPath)

  const lines = content.split(/\r?\n/)
  let multiline: '"""' | "'''" | null = null
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (multiline === null) {
      const found = projectHeaderPath(line)
      if (found !== null && trustKey(found) === want) {
        headerIdx = i
        break
      }
    }
    multiline = togglesMultiline(line, multiline)
  }

  if (headerIdx === -1) {
    const block = `[projects."${escapeTomlBasicString(projectPath)}"]${eol}${trustLine}${eol}`
    if (content.length === 0) return block
    const gap = content.endsWith(eol + eol) ? '' : content.endsWith(eol) ? eol : eol + eol
    return `${content}${gap}${block}`
  }

  // The block runs to the next structural table header, or to the end of the file.
  let end = lines.length
  multiline = null
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (multiline === null && /^\s*\[/.test(lines[i])) {
      end = i
      break
    }
    multiline = togglesMultiline(lines[i], multiline)
  }

  const trustLevelPattern = /^\s*trust_level\s*=\s*(?:"[^"]*"|'[^']*')\s*(?:#.*)?$/
  for (let i = headerIdx + 1; i < end; i++) {
    if (trustLevelPattern.test(lines[i])) {
      lines[i] = trustLine
      return lines.join(eol)
    }
  }
  lines.splice(headerIdx + 1, 0, trustLine)
  return lines.join(eol)
}

/**
 * The path codex will look this workspace up under: a git worktree resolves to the repository it
 * belongs to, anything else is itself.
 *
 * **This widens trust from one worktree to the whole repository, and that is the point.** Codex
 * resolves a worktree the same way when it decides whether a folder is trusted, so an entry written
 * for the worktree path alone is an entry it never reads — and the worktree is a checkout of that
 * repository anyway, made by this app, from a branch of it.
 *
 * The reciprocal link is checked before believing any of it: `.git` is a file inside the workspace,
 * so a worker could write one naming any directory on the machine, and without the check this
 * function would mark that directory trusted on its say-so. Git writes `.git/worktrees/<name>/gitdir`
 * pointing back at the workspace's own `.git`; if that does not match, the claim is refused and the
 * workspace path is used as-is.
 */
export async function codexTrustRoot(workspacePath: string): Promise<string> {
  try {
    const ref = (await fs.readFile(path.join(workspacePath, '.git'), 'utf8')).trim()
    if (!ref.startsWith('gitdir:')) return workspacePath
    const gitDirRef = ref.slice('gitdir:'.length).trim()
    if (!gitDirRef) return workspacePath
    const gitDir = path.resolve(workspacePath, gitDirRef)
    const worktreesDir = path.dirname(gitDir)
    if (path.basename(worktreesDir) !== 'worktrees') return workspacePath
    const backlink = (await fs.readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim()
    if (!backlink) return workspacePath
    const ours = path.join(workspacePath, '.git')
    if (trustKey(path.resolve(gitDir, backlink)) !== trustKey(ours)) return workspacePath
    // <repo>/.git/worktrees/<name> — two levels above `worktrees` is the repository root.
    return path.dirname(path.dirname(worktreesDir))
  } catch {
    // No `.git` file (an ordinary checkout has a directory), or it could not be read. Either way
    // there is nothing here that says this is a worktree.
    return workspacePath
  }
}

/**
 * Marks the repository behind `workspacePath` trusted in one codex account's config.toml.
 *
 * A no-op when the file already says so, because the alternative is rewriting the user's config on
 * every worker start — and the backup below would then overwrite itself with the copy it just made.
 * The write follows syncCodexSettings: back the file up to .bak, then tmp+rename, so a failure
 * cannot leave codex with half a config.
 */
export async function markCodexProjectTrusted(
  configDir: string,
  workspacePath: string
): Promise<void> {
  const root = await codexTrustRoot(workspacePath)
  const file = path.join(configDir, 'config.toml')
  let existing = ''
  try {
    existing = await fs.readFile(file, 'utf8')
  } catch {
    // absent is the empty file — upsertProjectTrust writes the whole block
  }
  const next = upsertProjectTrust(existing, root)
  if (next === existing) return
  await fs.mkdir(configDir, { recursive: true })
  await fs.copyFile(file, file + '.bak').catch(() => {}) // ignored when the target is absent
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, next, 'utf8')
  await fs.rename(tmp, file)
}
