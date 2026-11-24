/**
 * The Agent Context Bridge's pure parts (spec W4): what a piece of the workbench handed to an agent is (ContextRef), the
 * one place its text is masked, the text the agent receives, and which sessions may receive it.
 *
 * Context is attached, never acted on: the renderer pastes `contextText` into a session's input box and stops there,
 * and the person presses Enter (or does not). So this module decides nothing about running anything.
 *
 * node: no imports beyond core's pure modules. The renderer imports this file.
 */
import { sanitize } from '../orchestration/checkpoint'
import { foldPathCase } from '../files/paths'

/** How much of an excerpt an agent receives. The agent can read the file itself; the excerpt is the part the person
 *  pointed at, and a whole file pasted into a prompt is not that. */
export const CONTEXT_EXCERPT_LINES = 200
export const CONTEXT_EXCERPT_CHARS = 16_000

/**
 * A reference to one piece of the workbench (spec W4's ContextRef, audit §4's adjustment: projects and worktrees are
 * folders here, so `root` stands for the workspace and worktree ids the spec names). No `runtimeId`: every source this
 * builds from is this computer's (D6).
 */
export interface ContextRef {
  schemaVersion: 1
  kind: 'selection' | 'log' | 'diff'
  /** The folder the piece belongs to: the explorer's project a file was opened from, or the project a run ran in. */
  root: string
  /** The file, absolute, for a selection or a diff. */
  path?: string
  /** 1-based, inclusive. */
  range?: { startLine: number; endLine: number }
  /** What the file held when the piece was taken (contentRevision of its saved text). */
  revision?: string
  /** The run or Job the piece came from. */
  sourceId?: string
  /** A short name for the piece, as the person sees it. */
  label: string
}

/** The text with every secret masked (core/orchestration/checkpoint.ts sanitize, the redactor tab briefings, Slack's
 *  failure lines and MCP's session reads already share), and how many it masked. Every excerpt goes through this before
 *  it is shown in a preview or sent. */
export function maskForAgent(text: string): { text: string; masked: number } {
  const count = (s: string): number => s.split('[REDACTED]').length - 1
  const out = sanitize(text)
  return { text: out, masked: Math.max(0, count(out) - count(text)) }
}

/** A short fingerprint of a file's text (FNV-1a, 32 bits): enough to tell that a file changed since a piece was taken. */
export function contentRevision(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const normalized = (p: string): string => {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '')
  // A drive path is Windows, where case does not tell two folders apart
  return /^[a-zA-Z]:/.test(slashed) ? foldPathCase(slashed, 'win32') : slashed
}

/** Whether `target` is `base` or below it. Slashes either way; a drive-letter path compared without regard to case. */
export function isUnder(base: string, target: string): boolean {
  const b = normalized(base)
  const t = normalized(target)
  return t === b || t.startsWith(`${b}/`)
}

/**
 * Whether a session may receive this piece: a live session on this computer working in the piece's folder, and, for a
 * piece of a file, one whose folder holds that file. A session of another worktree has its folder elsewhere (spec W4:
 * another worktree's reference is refused), and a session started in a subfolder that does not hold the file would get
 * a path it cannot see as its own.
 */
export function sessionFits(ref: ContextRef, session: { cwd: string; alive: boolean; remote?: boolean }): boolean {
  if (!session.alive || session.remote === true) return false
  if (!isUnder(ref.root, session.cwd)) return false
  return ref.path === undefined || isUnder(session.cwd, ref.path)
}

/** `path` relative to `root`, with forward slashes; the whole path when it is not below it. */
function relative(root: string, path: string): string {
  if (!isUnder(root, path)) return path
  const r = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const cut = root.replace(/\\/g, '/').replace(/\/+$/, '').length + 1
  return r.slice(cut)
}

/**
 * The text an agent receives for a piece: a heading naming what it is, where it is from (the file and its lines, or the
 * run), the file's revision, then the excerpt, masked and capped, in a fenced block whose fence is longer than any run
 * of backticks in it. English, as every prompt Astera writes for an agent is.
 */
export function contextText(ref: ContextRef, excerpt: string, language = ''): { text: string; cut: boolean; masked: number } {
  const all = excerpt.split(/\r\n|\r|\n/)
  let lines = all.slice(0, CONTEXT_EXCERPT_LINES)
  let body = lines.join('\n')
  let cut = all.length > lines.length
  if (body.length > CONTEXT_EXCERPT_CHARS) {
    body = body.slice(0, CONTEXT_EXCERPT_CHARS)
    lines = body.split('\n')
    cut = true
  }
  const { text: safe, masked } = maskForAgent(body)
  const longest = Math.max(0, ...(safe.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const head: string[] = [`## Context from Astera: ${ref.kind}`]
  if (ref.path !== undefined) {
    const where = ref.range ? (ref.range.startLine === ref.range.endLine ? ` (line ${ref.range.startLine})` : ` (lines ${ref.range.startLine}-${ref.range.endLine})`) : ''
    head.push(`**File:** ${relative(ref.root, ref.path)}${where}`)
  } else head.push(`**Source:** ${ref.label}`)
  if (ref.revision !== undefined) head.push(`**Revision:** ${ref.revision}`)
  const tail = cut ? [`(cut: the first ${lines.length} of ${all.length} lines, up to ${CONTEXT_EXCERPT_CHARS} characters, are shown)`] : []
  return { text: [...head, '', `${fence}${language}`, safe, fence, ...tail, ''].join('\n'), cut, masked }
}
