import path from 'node:path'
import type { DetectCandidate } from '../types'
import { buildClaudeCommand, buildCodexCommand, type CommandBuilder } from '../sessions/commands'
import { readAccountEmail, detectConfigDirs } from '../accounts/detect'
import { readCodexEmail, detectCodexConfigDirs } from '../accounts/detectCodex'
import { PROVIDER_META, providerOf, type Provider, type ProviderMeta } from './meta'
import type { HistoryStrategy } from '../history/strategies/types'
import { claudeHistoryStrategy } from '../history/strategies/claude'
import { codexHistoryStrategy } from '../history/strategies/codex'

/**
 * A descriptor that gathers the values and functions differing per provider into one place.
 *
 * Why it is split from meta.ts: this file references node:path and fs-dependent functions, so the renderer
 * cannot import it. What the renderer needs (the list, the display strings, the capability flags) is in
 * meta.ts.
 *
 * Why a factory rather than a constant: the command builders are made per platform
 * (buildClaudeCommand(platform)). As a global constant, tests could not pin win32/darwin.
 */

// win32 first: ignores differences in path case and separator.
// (There used to be 4 copies of this rule — in manager.ts, settingsSync.ts, detectCodex.ts and core.ts.
// The consolidation merged only 2 of them: the private method in manager.ts and the inline normalizeDir in
// core.ts.)
// normalizePath in settingsSync.ts (:13) and normalize in detectCodex.ts (:7) are still alive and really
// used, by isDefaultConfigDir and isAmbientCodexDir respectively — today they are exactly identical to this
// rule (all of them path.resolve(p).toLowerCase()) but they are separate definitions. toLowerCase is the
// wrong rule on Linux, but changing the semantics was out of scope — whoever fixes that later has to look
// at all three places together.
const normalizePath = (p: string): string => path.resolve(p).toLowerCase()

export interface ProviderDescriptor extends ProviderMeta {
  /** The executable used for spawn and logout */
  cliFile: string
  logoutArgs: string[]
  /** The name of the isolation environment variable */
  configDirEnv: string
  /** The name of the home default (ambient) config dir */
  ambientDirName: string
  /** The file the login verdict rests on */
  credentialMarker: string
  /** The accounts root directory name — the caller (core.ts) assembles the absolute path */
  accountsRootName: string
  buildCommand: CommandBuilder
  readEmail(configDir: string, homeDir: string): Promise<string | null>
  detect(opts: { homeDir: string; excludeDirs: string[] }): Promise<DetectCandidate[]>
  history: HistoryStrategy
  /** Can busy/idle be decided reliably from the window-title OSC (BusyScanner, core/terminal/busy.ts)
   *  (measured on win32).
   *
   *  claude=true: the title transitions cleanly between a braille spinner (working) and ✳ (idle) — the
   *  BusyScanner verdict can be used as it is.
   *
   *  codex=false: a decorative spinner keeps streaming through the window title at 10 frames per second and
   *  does not stop even after the turn ends, and the child processes codex launches (npm, npm exec
   *  @playwright/mcp@latest, cmd.exe) overwrite the title. BusyScanner decides from "the first character of
   *  the last complete title", so busy↔idle flips spuriously several times a second — trusting that value as
   *  it is means a wait can go on forever (the decorative spinner happened to be printed last) or work that
   *  is actually in progress can be misread as idle (a child process title matched by coincidence).
   *
   *  Why it lives on ProviderDescriptor (Node only): the only place that reads this value is the coordinator
   *  wiring in main/orchestration — this flag is the reason
   *  CoordinatorDeps.isBusy(sessionId): boolean | null (main/orchestration/coordinator.ts) is tri-state
   *  (null = it cannot be decided for this provider). The renderer's session:busy display (App.tsx) does not
   *  consult this flag and uses the raw BusyScanner value (existing behaviour) — since the renderer has no
   *  use for it, it goes here rather than in meta.ts (which the renderer shares). */
  busyTitleReliable: boolean
}

export function makeDescriptors(
  platform: NodeJS.Platform
): Record<Provider, ProviderDescriptor> {
  return {
    claude: {
      ...PROVIDER_META.claude,
      cliFile: 'claude',
      logoutArgs: ['auth', 'logout'],
      configDirEnv: 'CLAUDE_CONFIG_DIR',
      ambientDirName: '.claude',
      credentialMarker: '.credentials.json',
      accountsRootName: '.claude-accounts',
      buildCommand: buildClaudeCommand(platform),
      readEmail: readAccountEmail,
      detect: detectConfigDirs,
      history: claudeHistoryStrategy,
      busyTitleReliable: true
    },
    codex: {
      ...PROVIDER_META.codex,
      cliFile: 'codex',
      logoutArgs: ['logout'],
      configDirEnv: 'CODEX_HOME',
      ambientDirName: '.codex',
      credentialMarker: 'auth.json',
      accountsRootName: '.codex-accounts',
      buildCommand: buildCodexCommand(platform),
      // readCodexEmail takes only configDir — this just wraps it to fit the descriptor shape (the original function is unchanged)
      readEmail: (configDir) => readCodexEmail(configDir),
      detect: detectCodexConfigDirs,
      history: codexHistoryStrategy,
      busyTitleReliable: false
    }
  }
}

export const descriptorOf = (
  table: Record<Provider, ProviderDescriptor>,
  a: { provider?: Provider }
): ProviderDescriptor => table[providerOf(a)]

/** Whether configDir is that provider's home default (ambient) directory.
 *  For an ambient dir the isolation environment variable is not injected — forcing it would make the CLI
 *  read a config with nothing in it and ask again for onboarding, login and folder trust. */
export function isAmbientDir(
  d: ProviderDescriptor,
  homeDir: string,
  configDir: string
): boolean {
  return normalizePath(configDir) === normalizePath(path.join(homeDir, d.ambientDirName))
}
