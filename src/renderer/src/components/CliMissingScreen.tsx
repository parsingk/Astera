import { useEffect, useRef, useState } from 'react'
import { installCommandFor, type InstallableCli } from '../../../core/install/cliInstall'
import { CATALOGS, LANGS } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'

/** The two programs, in the order they are offered. Neither is recommended over the other: the app
 *  runs both, and picking for someone is a claim this screen has no business making. */
const CLIS: readonly { id: InstallableCli; name: string; what: 'setup.claudeWhat' | 'setup.codexWhat' }[] =
  [
    { id: 'claude', name: 'Claude Code', what: 'setup.claudeWhat' },
    { id: 'codex', name: 'Codex', what: 'setup.codexWhat' }
  ]

type Phase =
  | { state: 'idle' }
  | { state: 'running'; cli: InstallableCli }
  | { state: 'done'; cli: InstallableCli; ok: boolean; code: number | null; error?: string }

/**
 * The screen shown when neither program is installed, which is the one state this app has nothing to
 * do in: it runs `claude` and `codex`, so with both missing there is nothing to run.
 *
 * It installs them rather than only naming them, with each vendor's own native installer for this
 * platform (core/install/cliInstall.ts holds the commands and why they are the native ones).
 *
 * Written for someone who has just installed the app and may never have opened a terminal. So the
 * command is not the first thing on screen — a button is, with a line saying where the download comes
 * from — and the command sits one click behind it for whoever wants to read or run it. The installer's
 * own output is behind the same kind of click, except on a failure, which is the one moment it is the
 * most useful thing here.
 *
 * It follows the stored language, and carries its own language switch. Those two go together: this
 * screen replaces the whole workbench, so the rail with the settings modal on it is never drawn, and
 * without a switch of its own a stored language someone cannot read would be a room with no door.
 */
export function CliMissingScreen(): React.JSX.Element {
  const { t, lang, setLang } = useI18n()
  const [phase, setPhase] = useState<Phase>({ state: 'idle' })
  const [shown, setShown] = useState<InstallableCli | null>(null) // whose command is expanded
  const [logOpen, setLogOpen] = useState(false)
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
  }, [log, logOpen])

  const install = (cli: InstallableCli): void => {
    setLog('')
    setLogOpen(false)
    setPhase({ state: 'running', cli })
    void window.api.system
      .installCli(cli)
      .then((r) => {
        setPhase({ state: 'done', cli, ok: r.ok, code: r.code, error: r.error })
        // A failure is the one time the installer's own words are the most useful thing on screen.
        if (!r.ok) setLogOpen(true)
      })
      .catch((err: unknown) => {
        setPhase({ state: 'done', cli, ok: false, code: null, error: String(err) })
        setLogOpen(true)
      })
  }

  const running = phase.state === 'running'
  const installed = phase.state === 'done' && phase.ok
  const installedName = installed ? CLIS.find((c) => c.id === phase.cli)?.name : null

  return (
    <div className="cli-missing">
      <h1>{t('setup.title')}</h1>
      <p>{t('setup.body')}</p>

      {installed ? (
        <>
          <p>{t('setup.done', { name: installedName ?? '' })}</p>
          <button
            type="button"
            className="cli-missing-primary"
            onClick={() => void window.api.system.relaunch()}
          >
            {t('setup.restart')}
          </button>
        </>
      ) : (
        <div className="cli-missing-actions">
          {CLIS.map(({ id, name, what }) => {
            const plan = installCommandFor(id, window.api.platform)
            const busy = running && phase.cli === id
            return (
              <div key={id} className="cli-missing-row">
                <div className="cli-missing-head">
                  <div>
                    <div className="cli-missing-name">{name}</div>
                    <div className="cli-missing-what">{t(what)}</div>
                  </div>
                  {plan && (
                    <button type="button" disabled={running} onClick={() => install(id)}>
                      {busy ? t('setup.installing') : t('setup.install')}
                    </button>
                  )}
                </div>
                {plan ? (
                  <>
                    <div className="cli-missing-source">
                      {t('setup.source', { host: plan.source })}
                      <button
                        type="button"
                        className="cli-missing-link"
                        onClick={() => setShown((prev) => (prev === id ? null : id))}
                      >
                        {shown === id ? t('setup.hideCommand') : t('setup.showCommand')}
                      </button>
                    </div>
                    {shown === id && <code>{plan.display}</code>}
                  </>
                ) : (
                  <div className="cli-missing-source">{t('setup.unsupported')}</div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {phase.state === 'done' && !phase.ok && (
        <p className="cli-missing-failed">
          {t('setup.failed')} {t('setup.failedHelp')}
        </p>
      )}

      {log !== '' && (
        <>
          <button
            type="button"
            className="cli-missing-link"
            onClick={() => setLogOpen((prev) => !prev)}
          >
            {logOpen ? t('setup.hideLog') : t('setup.showLog')}
          </button>
          {logOpen && (
            <pre ref={logRef} className="cli-missing-log">
              {log}
            </pre>
          )}
        </>
      )}

      {/* The door out of a language someone cannot read. The rail that normally holds this is not
          drawn on this screen, so without it the stored language would be final. */}
      <div className="cli-missing-lang">
        <span>{t('setup.language')}</span>
        {LANGS.map((l) => (
          <button
            key={l}
            type="button"
            className={`cli-missing-link${l === lang ? ' is-current' : ''}`}
            onClick={() => setLang(l)}
          >
            {CATALOGS[l].nativeName}
          </button>
        ))}
      </div>
    </div>
  )
}
