import type { Account } from '../types'
import { isAmbientDir, type ProviderDescriptor } from '../providers/descriptor'

/** Every environment variable this app plants into a spawned session. spawn clears all of them before
 *  deciding which to plant, so an inherited value can never pass through — see the comment at that
 *  call. **A new ASTERA_* injected into a session belongs in this list**; leaving it out reintroduces
 *  the leak for that one variable, and the absence of it is invisible until two app instances are
 *  running.
 *
 *  PATH is not here: it is the shell's, not ours, and spawn only prepends to it. An inherited shuttle
 *  directory can therefore still leave `astera` resolvable in a session with orchestration off, but
 *  with ASTERA_INFO cleared the CLI has no token to reach any server with and says so, which is the
 *  diagnosis the stub's tool check expects. */
export const MANAGED_ENV_KEYS = [
  'ASTERA_STATUSLINE_OUT',
  'ASTERA_STATUSLINE_ORIGINAL',
  'ASTERA_HOOK_OUT',
  'ASTERA_CLI',
  'ASTERA_INFO',
  'ASTERA_PROFILE_DIR',
  'ASTERA_SKILLS',
  'ASTERA_SESSION'
] as const

/**
 * What a Claude Code session sets to describe *itself*, cleared for the same reason as the list above
 * and with a worse symptom.
 *
 * Launch Astera from a terminal that is inside a Claude Code session — `npm run dev` from one, which
 * is exactly how this app gets developed — and the app inherits these. Every session it then spawns
 * is told it is a child of that session, and Claude Code answers by **writing no transcript at all**:
 * `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`, one line on the terminal
 * and nothing else. The conversation view reads a Claude session through that transcript, so it stays
 * empty forever, for a session answering perfectly well an inch away. Measured 2026-09-12: a session
 * spawned that way reported a transcript path for a file that was never created.
 *
 * Only what names the parent's session. `CLAUDE_CODE_GIT_BASH_PATH` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
 * are settings a person chose and are left exactly as they are — the one just below is read back a few
 * lines down on purpose.
 */
export const INHERITED_AGENT_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_EFFORT'
] as const

/** The environment a CLI child gets: a copy of `base` without the app-managed and inherited-agent keys,
 *  with the provider's config-dir variable set to the account's dir — or deleted when that dir is the
 *  ambient one (`isAmbientDir`). Exactly what SessionManager.spawn did inline. */
export function cliEnvFor(a: {
  base: NodeJS.ProcessEnv
  account: Account
  descriptor: ProviderDescriptor
  homeDir: string
}): Record<string, string | undefined> {
  // The default account (configDir is the home default dir) gets no isolation environment variable.
  // claude's main state (onboarding, oauthAccount, folder trust) lives in the home-root
  // ~/.claude.json and is only used when CLAUDE_CONFIG_DIR is unset, so forcing it on the default
  // account makes claude read a config with none of that and ask for onboarding, login and trust
  // all over again. codex applies the same rule to CODEX_HOME/~/.codex.
  const env: Record<string, string | undefined> = { ...a.base }
  if (isAmbientDir(a.descriptor, a.homeDir, a.account.configDir)) delete env[a.descriptor.configDirEnv]
  else env[a.descriptor.configDirEnv] = a.account.configDir
  // Every variable this app plants into a session is cleared before the branches below decide which
  // ones to plant. **Not setting one is not the same as clearing it**: this env starts as a copy of
  // the app process's, and launching Astera from the shell of an Astera session — which is what
  // `npm run dev` from a session terminal is — means the app itself inherits another instance's
  // ASTERA_*. Passed on, a session spawned with the orchestration, work-unit-tracking and
  // agent-browser toggles all off hands its agent a live CLI path and token aimed at that other
  // instance, an inherited ASTERA_SESSION makes it report under another session's identity, and inherited
  // capture paths mix this session's statusLine and hook output into another instance's files.
  // Same rule as configDirEnv on the line above, and as runAccountLogout in main/core.ts.
  for (const k of MANAGED_ENV_KEYS) delete env[k]
  // ...and the same for the marks a Claude Code session leaves on its own environment, whose
  // consequence is a session that writes no transcript. See that list's own note.
  for (const k of INHERITED_AGENT_ENV_KEYS) delete env[k]
  return env
}
