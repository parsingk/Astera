// GitHub lifecycle G6 (design §6.3 S5, L15): the Host's state load is lazy on purpose — the first command loads it — and a
// Host `astera runtime serve` started runs with no client by design, so a CI wait in its file would never resume after a
// restart until a controller called. Such a Host loads its state ten seconds after it starts, unless an app attached by
// then (the app's own `state-get` loads it, with the boot findings).
//
// The Host cannot tell `runtime serve` from `host start`: the spawn plan drops every inherited ASTERA_HOST_* variable
// (core/host/spawn.ts). Remote being on is the sign it goes by — serve requires it, and a CLI start loads on its own
// command anyway (G6 plan ruling 1).

/** How long a Remote Host waits for an app before it loads by itself. */
export const EARLY_LOAD_MS = 10_000

export interface EarlyLoadDeps {
  /** Read when it fires: remote-runtime.json can change in the meantime. */
  remoteEnabled(): boolean
  hasApp(): boolean
  /** HostOrch.loadUnattended: memoized, so a load a command already made is not repeated. */
  load(): Promise<void>
  log(m: string): void
}

/** Arms the one-shot. The timer is unref'd: it never keeps a Host up. Never throws. */
export function armEarlyLoad(d: EarlyLoadDeps): { cancel(): void } {
  const timer = setTimeout(() => {
    if (!d.remoteEnabled() || d.hasApp()) return
    d.log('early load: Remote is on and no app attached within 10 s — loading the state so its CI waits resume')
    void d.load().catch((err) => d.log(`early load failed: ${String(err)}`))
  }, EARLY_LOAD_MS)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}
