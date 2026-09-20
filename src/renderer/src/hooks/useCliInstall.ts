import { useEffect, useRef, useState, type RefObject } from 'react'
import type { InstallableCli } from '../../../core/install/cliInstall'

/** Where an install attempt is. `unseen` is the one case that asks for a restart: the installer said
 *  it succeeded and the machine still cannot find the program, which no amount of waiting fixes. */
export type CliInstallPhase =
  | { state: 'idle' }
  | { state: 'running'; cli: InstallableCli }
  | { state: 'done'; cli: InstallableCli; ok: boolean; code: number | null; error?: string }
  | { state: 'unseen'; cli: InstallableCli }

/**
 * Installing one of the two CLIs, with the installer's own output as it arrives.
 *
 * Lifted out of CliMissingScreen.tsx, which owned all of this, when Settings needed the same thing.
 * The two screens ask for it in different situations and draw it differently — one is the whole
 * window when nothing is installed, the other is two rows inside a modal — but the machinery is
 * identical and duplicating it would mean two places to get the event subscription, the success
 * re-check and the `unseen` case right.
 *
 * Why Settings needs it at all: the full-screen version is only reachable when **neither** CLI is on
 * the machine. A CLI that is installed but does not run — a broken install, a half-finished upgrade —
 * never reaches it, and since the app entry gate was corrected to ask about installation rather than
 * runnability (design §7 F6), it never will. Without a second door, that person has no way to
 * reinstall from inside the app at all.
 *
 * `onInstalled` is handed the fresh **existence** check, not a runnability one, for the reason the
 * gate itself gives: a CLI that installed perfectly well but that a toolchain manager refuses to run
 * in this folder must not be reported back as still missing.
 */
export function useCliInstall(onInstalled: (installed: { claude: boolean; codex: boolean }) => void): {
  phase: CliInstallPhase
  log: string
  logOpen: boolean
  setLogOpen: (next: boolean | ((prev: boolean) => boolean)) => void
  logRef: RefObject<HTMLPreElement | null>
  install: (cli: InstallableCli) => void
} {
  const [phase, setPhase] = useState<CliInstallPhase>({ state: 'idle' })
  const [log, setLog] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  // Read through a ref so a caller that passes an inline arrow (both of them do) does not re-subscribe
  // or re-create `install` on every render.
  const onInstalledRef = useRef(onInstalled)
  onInstalledRef.current = onInstalled

  useEffect(() => {
    return window.api.on('cli:install', (e) => {
      if (e.kind === 'done') return // the handler's own answer settles the phase; this would race it
      setLog((prev) => prev + e.text)
    })
  }, [])

  // A log that does not follow its own output is a log nobody can read while it matters.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log, logOpen])

  const install = (cli: InstallableCli): void => {
    setLog('')
    setLogOpen(false)
    setPhase({ state: 'running', cli })
    void window.api.system
      .installCli(cli)
      .then(async (r) => {
        if (!r.ok) {
          setPhase({ state: 'done', cli, ok: false, code: r.code, error: r.error })
          // A failure is the one time the installer's own words are the most useful thing on screen.
          setLogOpen(true)
          return
        }
        // Main has already put what it found on its own PATH (adoptInstalledCli), so this check can
        // see it and the app carries straight on. No restart, no second screen saying it worked.
        const next = await window.api.system.checkCliInstalled().catch(() => null)
        if (next && (next.claude || next.codex)) {
          setPhase({ state: 'done', cli, ok: true, code: 0 })
          onInstalledRef.current(next)
          return
        }
        setPhase({ state: 'unseen', cli })
      })
      .catch((err: unknown) => {
        setPhase({ state: 'done', cli, ok: false, code: null, error: String(err) })
        setLogOpen(true)
      })
  }

  return { phase, log, logOpen, setLogOpen, logRef, install }
}
