// The app's orchestration commands that need the Host's GitHub (GitHub lifecycle G7a). The app runs its own commands
// in main, whose copy of the command layer has no gh and no origin (`OrchServerDeps.github` is the Host's alone), so
// these answered 409 from the app while the same command through the Host works: a Job made with the lifecycle on, a
// GitHub question's continue (a fast-forward from GitHub) and rerun (a CI rerun), reconverge's live read of the pull
// request, and the preflight. Main sends them to the Host as it sends a validator's `lifecycle-ci-begin`. Node-free.
import type { OrchState } from './state'
import { isGitHubGateKind } from './types'

export function needsHostGitHub(s: OrchState, cmd: string, args: Record<string, unknown>): boolean {
  switch (cmd) {
    case 'run-create':
    case 'jobs-create':
      return args.githubLifecycle === true
    // Every answer to a GitHub question, not only the two that reach GitHub: one question's answers are one rule
    case 'gate-resolve':
    case 'questions-answer': {
      const gate = s.gates.find((g) => g.id === args.id)
      return gate !== undefined && isGitHubGateKind(gate.kind)
    }
    case 'runs-reconverge':
    case 'github-preflight':
      return true
    default:
      return false
  }
}
