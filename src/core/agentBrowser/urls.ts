// The one address rule for the agent's browser. The user's own preview may show any http(s) page;
// the agent's tab is held to this machine, which is what keeps this feature and a general agent
// browser (ego-lite) from ever being asked the same question.
import { isLoopbackUrl, previewTargetOf } from '../preview/url'

/** The URL `open()` will load, or null when the agent may not open it. Loopback only; `0.0.0.0` and
 *  `[::]` — addresses a dev server prints but a browser cannot navigate to — become `localhost`. */
export function agentOpenTarget(url: string): string | null {
  if (!isLoopbackUrl(url)) return null
  return previewTargetOf(url)
}
