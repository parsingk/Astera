// 설정하기 on the Host (sandbox design §6): Codex's Windows sandbox setup for the one account a sandboxed start was refused
// for (`SANDBOX_UNAVAILABLE: windows-setup codex <account>`), run in that account's home, in the environment the Host's
// sessions start from. The person decided accounts are set up one at a time (Task 6): a setup gives the machine's
// sandbox users new passwords that only the home set up keeps.
//
// Imports only core modules: this bundles into the Host.
import type { Account } from '../core/types'
import type { Provider } from '../core/providers/meta'
import { descriptorOf, type ProviderDescriptor } from '../core/providers/descriptor'
import { cliEnvFor } from '../core/sessions/cliEnv'
import { SETUP_RUN_MS, codexWindowsSetup, runCodex, type CodexRun } from '../core/sandbox/windowsReadiness'

/** The setup for `agent-profiles-sandbox-setup`, or undefined off Windows, where there is none to run. */
export function hostSandboxSetup(d: {
  platform: NodeJS.Platform
  homeDir: string
  /** Read at each setup: the Host completes its PATH when a CLI is missing (windowsPath.ts). */
  baseEnv: () => NodeJS.ProcessEnv
  descriptors: Record<Provider, ProviderDescriptor>
  /** Test injection; default the codex on this machine's PATH, waiting up to SETUP_RUN_MS for the administrator prompt. */
  run?: (env: Record<string, string | undefined>) => CodexRun
}): ((account: Account) => Promise<{ ok: boolean; out: string }>) | undefined {
  if (d.platform !== 'win32') return undefined
  const runIn = d.run ?? ((env: Record<string, string | undefined>) => runCodex(env, SETUP_RUN_MS))
  return (account) => {
    // The account's CODEX_HOME as its sessions get it (none for the ambient account), so the home set up is the one a
    // sandboxed start of it asks about
    const env = cliEnvFor({ base: d.baseEnv(), account, descriptor: descriptorOf(d.descriptors, account), homeDir: d.homeDir })
    return codexWindowsSetup({ codexHome: env.CODEX_HOME ?? null, run: runIn(env) })
  }
}
