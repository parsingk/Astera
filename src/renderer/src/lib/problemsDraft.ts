import { contextText } from '../../../core/context/contextRef'
import type { Diagnostic } from '../../../core/problems/diagnostic'
import { problemsContext } from './contextSources'

/**
 * Problems no Task can take a repair for, as a new Job's objective (Phase 3 Part 1), the way a diff hunk becomes one
 * (hunks.ts repairObjective): a line asking for the fix and naming the checks that found the problems, so the coordinator
 * verifies with them (the new Job form has no checks of its own to pick), then the problems through contextText, which
 * says they are data and masks what they carry. Their files' lines are left to the agent, who can read the files.
 */
export function problemsObjective(rows: readonly Diagnostic[], root: string): string {
  const made = problemsContext({ rows, root, files: {}, anyFolder: true })
  if (!made.ok) return ''
  const checks = [...new Set(rows.filter((d) => d.source.kind === 'check').map((d) => d.source.label))]
  return [
    `Fix the problems below, found in this project.${checks.length > 0 ? ` Verify the fix with: ${checks.join(', ')}.` : ''}`,
    '',
    contextText(made.ref, made.excerpt).text
  ].join('\n')
}
