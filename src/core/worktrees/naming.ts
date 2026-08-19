import path from 'node:path'

export const MAX_SUFFIX_ATTEMPTS = 20

/** Keeps Unicode letters, digits and ._- ; everything else becomes -, .. collapses to ., leading and trailing .- are trimmed */
export function slugify(input: string): string {
  const s = input
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
  if (!s) throw new Error('INVALID_NAME: the name contains no usable characters')
  return s
}

// Automatic naming — short, neutral words. Collisions are resolved by the candidateName suffix.
const AUTO_WORDS = [
  'coral', 'delta', 'ember', 'fjord', 'grove', 'harbor', 'indigo', 'juniper', 'lagoon', 'maple',
  'nova', 'opal', 'pearl', 'quartz', 'reef', 'sable', 'tundra', 'umber', 'willow', 'zephyr'
] as const

export function autoName(random: () => number = Math.random): string {
  return AUTO_WORDS[Math.min(AUTO_WORDS.length - 1, Math.floor(random() * AUTO_WORDS.length))]
}

/** Name for a `--worktree new` call, derived from a task's title. slugify throws when the title has
 *  no usable characters at all (all-punctuation, all-whitespace) — that is a real "cannot compute a
 *  name" failure, not a shape createWorktree already handles, so it is caught here and the task id
 *  is used instead. The id is always present, always unique (newId), and already safe as a git ref
 *  (its `prefix_hexhexhexhex` shape is exactly what slugify would keep unchanged), so it needs no
 *  further processing.
 *
 *  Takes a structural shape rather than importing orchestration's Task type — worktrees sits below
 *  orchestration in the dependency order and must not point back up at it. */
export function nameForTask(task: { id: string; title: string }): string {
  try {
    return slugify(task.title)
  } catch {
    return task.id
  }
}

export function branchNameFor(gitUserName: string | null, slug: string): string {
  if (!gitUserName) return slug
  try {
    return `${slugify(gitUserName)}/${slug}`
  } catch {
    return slug
  }
}

export function candidateName(base: string, attempt: number): string {
  return attempt === 1 ? base : `${base}-${attempt}`
}

export function repoDirName(repoPath: string): string {
  return path.basename(repoPath).replace(/\.git$/, '') || 'repo'
}

export function worktreePathFor(root: string, repoPath: string, slug: string): string {
  return path.join(root, repoDirName(repoPath), slug)
}
