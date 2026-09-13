import { useEffect, useRef, useState } from 'react'
import { installCommandFor, type InstallableCli } from '../../../core/install/cliInstall'

/** What the two CLIs are called where a person reads them, and the order they are offered in. */
const CLIS: readonly { id: InstallableCli; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' }
]

type Phase =
  | { state: 'idle' }
  | { state: 'running'; cli: InstallableCli }
  | { state: 'done'; cli: InstallableCli; ok: boolean; code: number | null; error?: string }

/**
 * The screen shown when neither CLI is installed, which is the one state this app has nothing to do
 * in: it is a launcher for `claude` and `codex`, so with both missing there is nothing to launch.
 *
 * It installs them rather than only naming them. The commands are each vendor's own native installer
 * for this platform (core/install/cliInstall.ts), which matters because they bring their own binary —
 * the npm route needs Node 22+, and telling someone to install a runtime in order to install a CLI is
 * a second wall in front of the first.
 *
 * Deliberately English-only, and deliberately not routed through `t()`. This screen replaces the whole
 * workbench, so the rail is never rendered — and the settings modal that holds the language switch
 * lives on that rail. Someone stuck here cannot change the language, so the text stays in the one
 * language every reader of these commands already has to read. Do not move these strings into the
 * i18n catalog: following the stored language is exactly the behaviour being avoided.
 */
export function CliMissingScreen(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ state: 'idle' })
  const [log, setLog] = useState('')
  const logRef = useRef<HTMLPreElement>(null)

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
  }, [log])

  const install = (cli: InstallableCli): void => {
    setLog('')
    setPhase({ state: 'running', cli })
    void window.api.system
      .installCli(cli)
      .then((r) => setPhase({ state: 'done', cli, ok: r.ok, code: r.code, error: r.error }))
      .catch((err: unknown) =>
        setPhase({ state: 'done', cli, ok: false, code: null, error: String(err) })
      )
  }

  const running = phase.state === 'running'
  const installed = phase.state === 'done' && phase.ok

  return (
    <div className="cli-missing">
      <h1>No CLI found to run</h1>
      <p>
        This app is a launcher that runs the installed <code>claude</code> or <code>codex</code> CLI.
        Install either one to continue.
      </p>

      {installed ? (
        <>
          <p>
            {CLIS.find((c) => c.id === (phase as { cli: InstallableCli }).cli)?.label} is installed.
            Restart the app to start using it.
          </p>
          <button
            type="button"
            className="cli-missing-primary"
            onClick={() => void window.api.system.relaunch()}
          >
            Restart Astera
          </button>
        </>
      ) : (
        <div className="cli-missing-actions">
          {CLIS.map(({ id, label }) => {
            const plan = installCommandFor(id, window.api.platform)
            return (
              <div key={id} className="cli-missing-row">
                <div className="cli-missing-name">{label}</div>
                <code>{plan?.display ?? 'No installer is known for this platform'}</code>
                {plan && (
                  <button type="button" disabled={running} onClick={() => install(id)}>
                    {running && phase.cli === id ? 'Installing…' : 'Install'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {phase.state === 'done' && !phase.ok && (
        <p className="cli-missing-failed">
          {phase.error ?? `The installer exited with code ${String(phase.code)}.`} You can run the
          command above yourself, then restart the app.
        </p>
      )}

      {log !== '' && (
        <pre ref={logRef} className="cli-missing-log">
          {log}
        </pre>
      )}
    </div>
  )
}
