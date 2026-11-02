// The action-to-class table (lifecycle design §4.6), beside the coverage tables it is read against: each action the
// resolver names maps to the classes its calls arrive through, so a Rule's action can be held to what a CLI and session
// kind can see (COVERAGE) or block (COVERAGE_ENFORCE). An action that reaches the hook two ways maps to both: a file
// action comes by file tool and by shell, a git push only by shell. `agent.spawn` and `other` have no row in the coverage
// tables, so they map to none (plan ruling 4).
import { AUDIT_ACTIONS, ruleMatches } from './policy'
import type { AuditAction, CoverageClass } from './types'

/** A record, so the compiler holds it to the resolver's list: an action missing here fails to build. The file class comes
 *  first, so a reason names the class the action is about before the shell it also arrives by. */
export const ACTION_CLASSES: Record<AuditAction, CoverageClass[]> = {
  'process.execute': ['shell'],
  'git.read': ['shell'],
  'git.local.write': ['shell'],
  'git.remote.write': ['shell'],
  'github.pr.create': ['shell'],
  'github.write': ['shell'],
  'package.install': ['shell'],
  'filesystem.read': ['file-read', 'shell'],
  'filesystem.write': ['file-write', 'shell'],
  'filesystem.delete': ['file-write', 'shell'],
  'network.request': ['network'],
  'mcp.call': ['mcp'],
  'agent.spawn': [],
  other: []
}

/** Every action the resolver names that a Rule's pattern matches, in the resolver's order. */
export const actionsOfRule = (action: string): AuditAction[] => AUDIT_ACTIONS.filter((a) => ruleMatches(action, a))

/** Every class of the actions, each once, in the order they first reach it. */
export const classesOf = (actions: readonly AuditAction[]): CoverageClass[] => [...new Set(actions.flatMap((a) => ACTION_CLASSES[a]))]

/** Every class of every action a Rule's pattern matches (`git.*` gives shell). */
export const classesOfRule = (action: string): CoverageClass[] => classesOf(actionsOfRule(action))
