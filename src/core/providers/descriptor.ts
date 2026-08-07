import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import type { DetectCandidate } from '../types'
import { buildClaudeCommand, buildCodexCommand, type CommandBuilder } from '../sessions/commands'
import { readAccountEmail, detectConfigDirs } from '../accounts/detect'
import { readCodexEmail, detectCodexConfigDirs } from '../accounts/detectCodex'
import { syncClaudeSettings, syncCodexSettings, type SyncResult } from '../accounts/settingsSync'
import { PROVIDER_META, providerOf, type Provider, type ProviderMeta } from './meta'
import type { HistoryStrategy } from '../history/strategies/types'
import { claudeHistoryStrategy } from '../history/strategies/claude'
import { codexHistoryStrategy } from '../history/strategies/codex'
import { keychainAccount, makeSecurityKeychainHas } from '../accounts/keychain'
import { claudeLoginProbe, fileMarkerProbe, type LoginProbe } from '../accounts/loginStatus'

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
// used, by isHomeClaudeDir and isAmbientCodexDir respectively — today they are exactly identical to this
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
  /** 이 계정이 로그인되어 있는가. 근거는 프로바이더와 플랫폼마다 다르다 — accounts/loginStatus.ts 참고 */
  isLoggedIn: LoginProbe
  /** The accounts root directory name — the caller (core.ts) assembles the absolute path */
  accountsRootName: string
  buildCommand: CommandBuilder
  readEmail(configDir: string, homeDir: string): Promise<string | null>
  detect(opts: { homeDir: string; excludeDirs: string[] }): Promise<DetectCandidate[]>
  /** Copies this provider's settings from one of its accounts into another. The source is that provider's
   *  default account (accounts/defaultAccount.ts), not the home directory — the two are usually the same
   *  account but no longer the same concept.
   *
   *  The two providers behave differently and deliberately so: claude merges per key, codex replaces the
   *  whole config.toml (no TOML parser here). The confirmation wording splits on the same line. */
  syncSettings(srcConfigDir: string, targetConfigDir: string, homeDir: string): Promise<SyncResult>
  history: HistoryStrategy
  /** Can busy/idle be decided reliably from the window-title OSC (BusyScanner, core/terminal/busy.ts)
   *  (measured on win32 and darwin).
   *
   *  The darwin measurement was done headlessly rather than through the packaged app: a script drove
   *  a real claude session over node-pty, replicating the production BusyScanner algorithm exactly and
   *  logging every busy/idle transition it produced. Over a 110s run it recorded exactly three
   *  transitions — a braille spinner frame while the turn was in progress, ✳ once it went idle, and a
   *  stable idle state afterwards — with no spurious flipping in between. That matches the win32
   *  behaviour documented below, so the flag stays a platform-independent `true` for claude.
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

/** security(1) 를 돌려 종료 코드만 돌려준다. stdout/stderr 는 버린다 (존재 여부만 필요하다). */
function runSecurity(file: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000 }, (err) => {
      resolve(err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0)
    })
  })
}

export function makeDescriptors(
  platform: NodeJS.Platform,
  /** 테스트에서 키체인 조회를 갈아끼우기 위한 자리. 실제 배선은 기본값을 그대로 쓴다. */
  homeDir: string = os.homedir(),
  keychainHas = makeSecurityKeychainHas(runSecurity)
): Record<Provider, ProviderDescriptor> {
  const claudeIsLoggedIn = claudeLoginProbe({
    platform,
    homeDir,
    account: keychainAccount({ USER: process.env.USER }, os.userInfo().username),
    keychainHas
  })
  return {
    claude: {
      ...PROVIDER_META.claude,
      cliFile: 'claude',
      logoutArgs: ['auth', 'logout'],
      configDirEnv: 'CLAUDE_CONFIG_DIR',
      ambientDirName: '.claude',
      isLoggedIn: claudeIsLoggedIn,
      accountsRootName: '.claude-accounts',
      buildCommand: buildClaudeCommand(platform),
      readEmail: readAccountEmail,
      detect: (o) => detectConfigDirs({ ...o, isLoggedIn: claudeIsLoggedIn }),
      syncSettings: syncClaudeSettings,
      history: claudeHistoryStrategy,
      busyTitleReliable: true
    },
    codex: {
      ...PROVIDER_META.codex,
      cliFile: 'codex',
      logoutArgs: ['logout'],
      configDirEnv: 'CODEX_HOME',
      ambientDirName: '.codex',
      isLoggedIn: fileMarkerProbe('auth.json'),
      accountsRootName: '.codex-accounts',
      buildCommand: buildCodexCommand(platform),
      // readCodexEmail takes only configDir — this just wraps it to fit the descriptor shape (the original function is unchanged)
      readEmail: (configDir) => readCodexEmail(configDir),
      detect: detectCodexConfigDirs,
      // homeDir is unused here — codex keeps everything inside configDir, with no home-root sidecar
      syncSettings: (srcConfigDir, targetConfigDir) =>
        syncCodexSettings(srcConfigDir, targetConfigDir),
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
