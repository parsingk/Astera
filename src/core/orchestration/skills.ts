// The shapes `astera skills list` and `astera skills install` answer with, and the settings that
// gate the skills. Types only.
//
// **Here in core, not beside the code that builds them** (src/cli/skills.ts, src/main/orchestration/
// stub.ts), because cliPublic.ts allowlists these shapes and core does not import from cli or main.
import type { Provider, ResumeStrategy } from '../types'

/** What is at one stub's target, judged by the ownership rule `installStub` acts on. `stale` is a
 *  file of ours that install would rewrite; `not-ours` is one it leaves alone. */
export type StubState = 'missing' | 'current' | 'stale' | 'not-ours'

/** The settings that gate the stubs, as values: the CLI hands in what it read from the profile's
 *  app-settings.json and the app what it holds in memory. */
export interface SkillSettings {
  workUnitTrackingEnabled: boolean
  agentBrowserEnabled: boolean
  resumeStrategy: ResumeStrategy
}

/** One skill in `skills list`. */
export interface SkillListed {
  name: string
  /** Whether the current settings install it. */
  enabled: boolean
  installed: StubState
}

/** What `skills install` did with one skill in one account. `failed` is a write or read that threw,
 *  or a source that could not be installed; the reason is on stderr. */
export type SkillInstallResult = 'written' | 'unchanged' | 'skipped-not-ours' | 'failed'

export interface SkillInstalled {
  name: string
  result: SkillInstallResult
}

/** A skill `skills install` left out because its setting is off, and where that setting is. */
export interface SkillNotEnabled {
  name: string
  setting: string
}

export interface SkillsAccount {
  id: string
  label: string
  provider: Provider
  skills: SkillListed[] | SkillInstalled[]
}
