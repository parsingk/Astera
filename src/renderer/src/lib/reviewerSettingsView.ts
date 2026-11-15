// The decisions of the Settings "Reviewer" group (external reviewers), apart from the component so they can be tested:
// the renderer has no DOM test environment. Every value produced here survives the store's narrowing unchanged
// (reviewerSettingsOf in core/settings/externalReviewers.ts): name trimmed, 1 to 40 characters, one line; command
// trimmed, non-empty, one line, not a relative path; at most 20 args.
import type { ReviewerProbe } from '../../../core/acp/probeTypes'
import {
  MAX_EXTERNAL_REVIEWERS,
  isRelativeCommandPath,
  newExternalReviewerId,
  type ExternalReviewer,
  type ReviewerSettings
} from '../../../core/settings/externalReviewers'
import type { MessageKey, MessageParams } from '../../../core/i18n'

const MAX_NAME_LENGTH = 40
const MAX_ARGS = 20
const LINE_BREAK = /[\r\n]/
/** The one command line the person edits (`gemini --acp`) as the store keeps it: the first part is the command, the rest
 *  its args. `name` is passed through for the caller to validate. */
export function fieldsOfLine(name: string, line: string): Fields {
  const [command = '', ...args] = argsOfLine(line)
  return { name, command, args }
}

/** A registered reviewer as its command line reads */
export const lineOfReviewer = (r: Pick<ExternalReviewer, 'command' | 'args'>): string => lineOfArgs([r.command, ...r.args])

/** A reviewer's name in a chip is cut here; the element's title holds the whole name */
const CHIP_NAME_MAX = 20

type Fields = Omit<ExternalReviewer, 'id'>
type FieldError = { error: 'name' | 'command' }

/** The fields as the store keeps them, or the field that does not fit. Too many args reads as a bad command line. */
function cleaned(r: Fields): Fields | FieldError {
  const name = r.name.trim()
  const command = r.command.trim()
  if (!name || name.length > MAX_NAME_LENGTH || LINE_BREAK.test(name)) return { error: 'name' }
  if (!command || LINE_BREAK.test(command) || isRelativeCommandPath(command) || r.args.length > MAX_ARGS) return { error: 'command' }
  return { name, command, args: [...r.args] }
}

export function withReviewerAdded(s: ReviewerSettings, r: Fields): ReviewerSettings | { error: 'limit' | 'name' | 'command' } {
  if (s.reviewers.length >= MAX_EXTERNAL_REVIEWERS) return { error: 'limit' }
  const c = cleaned(r)
  if ('error' in c) return c
  let id = newExternalReviewerId()
  while (s.reviewers.some((x) => x.id === id)) id = newExternalReviewerId()
  return { ...s, reviewers: [...s.reviewers, { id, ...c }] }
}

/** `r` without the entry of `id`: a reviewer's Test result once it no longer describes the reviewer (a saved edit). */
export function withoutKey<T>(r: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _gone, ...rest } = r
  return rest
}

/** A removed choice returns to automatic (null) */
export function withReviewerRemoved(s: ReviewerSettings, id: string): ReviewerSettings {
  return { reviewers: s.reviewers.filter((r) => r.id !== id), reviewBy: s.reviewBy === id ? null : s.reviewBy }
}

export function withReviewerEdited(s: ReviewerSettings, r: ExternalReviewer): ReviewerSettings | FieldError {
  const c = cleaned(r)
  if ('error' in c) return c
  return { ...s, reviewers: s.reviewers.map((x) => (x.id === r.id ? { id: r.id, ...c } : x)) }
}

/** The args line the person edits. Whitespace separates args. A double-quoted section groups (its quotes are removed)
 *  and may sit anywhere in an arg, as in --root="C:\a b\". Inside a quoted section two double quotes in a row are
 *  one literal double quote. A backslash is always itself and escapes nothing, so a Windows path may end in one before
 *  its closing quote. A quoted section alone is an empty arg; an unterminated quote runs to the end of the line. */
export function argsOfLine(line: string): string[] {
  const args: string[] = []
  let cur = ''
  let has = false
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        quoted = !quoted
      }
      has = true
    } else if (!quoted && /\s/.test(ch)) {
      if (has) args.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has) args.push(cur)
  return args
}

/** The inverse of argsOfLine: an arg that is empty or holds whitespace or a double quote is wrapped in double quotes, each
 *  inner double quote doubled; any other arg is written as it is. Every string without a line break round trips. */
export function lineOfArgs(args: string[]): string {
  return args
    .map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
    .join(' ')
}

/** A reviewer's name as a chip shows it */
export function reviewerChipName(name: string): string {
  const chars = Array.from(name)
  return chars.length > CHIP_NAME_MAX ? `${chars.slice(0, CHIP_NAME_MAX).join('')}…` : name
}

type Translate = (key: MessageKey, params?: MessageParams) => string

/** What the Test button's answer says, in the person's language by `kind` */
export function probeText(p: ReviewerProbe, t: Translate): string {
  if (p.ok) {
    const { title, name, version } = p.agent
    const agent = [title ?? name, version].filter((x): x is string => !!x).join(' ')
    return t('settings.reviewer.test.ok', { agent })
  }
  switch (p.kind) {
    case 'not-found':
      return t('settings.reviewer.test.not-found')
    case 'timeout':
      return t('settings.reviewer.test.timeout')
    case 'unsupported-version':
      return t('settings.reviewer.test.unsupported-version')
    case 'sign-in':
      return t('settings.reviewer.test.sign-in', { message: p.message })
    default:
      return t('settings.reviewer.test.failed', { message: p.message })
  }
}
