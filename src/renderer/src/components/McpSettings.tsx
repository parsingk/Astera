import { useEffect, useState } from 'react'
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { CliInstallStatus, McpAccess, McpClient, McpClientStatus } from '../../../core/types'
import { mcpRegistrationLines, shimPathFor, type McpRegistrationLine } from '../../../core/install/mcpRegistration'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { Select } from './Select'

/** The saved value into `set`, or a toast when it cannot be read; the control then keeps its default. */
export function loadMcpAccess(
  set: (a: McpAccess) => void,
  t: (key: MessageKey, params?: MessageParams) => string
): Promise<void> {
  return window.api.settings.getMcpAccess().then(set, (err) => {
    toast.error(t('settings.mcp.loadFailed', { detail: err instanceof Error ? err.message : String(err) }))
  })
}

/** The saved sessions value into `set`, or a toast when it cannot be read; the box then stays at its
 *  default (off) and the person is told it may not show what is saved. */
export function loadMcpSessions(
  set: (v: boolean) => void,
  t: (key: MessageKey, params?: MessageParams) => string
): Promise<void> {
  return window.api.settings.getMcpSessions().then(set, (err) => {
    toast.error(t('settings.mcp.sessions.loadFailed', { detail: err instanceof Error ? err.message : String(err) }))
  })
}

/** The sessions checkbox does nothing while access is off (the Host refuses every call then). */
export function sessionsDisabled(access: McpAccess): boolean {
  return access === 'off'
}

/** Shows `next` at once, saves it, and puts `prev` back with a toast when the save fails. */
export function saveMcpSessions(
  next: boolean,
  prev: boolean,
  set: (v: boolean) => void,
  t: (key: MessageKey, params?: MessageParams) => string
): Promise<void> {
  set(next)
  return window.api.settings.setMcpSessions(next).catch((err) => {
    set(prev)
    toast.error(t('settings.mcp.sessions.saveFailed', { detail: err instanceof Error ? err.message : String(err) }))
  })
}

/** The saved GitHub-writes value into `set`, or a toast when it cannot be read; the box then stays at
 *  its default (off). */
export function loadMcpGithubWrite(
  set: (v: boolean) => void,
  t: (key: MessageKey, params?: MessageParams) => string
): Promise<void> {
  return window.api.settings.getMcpGithubWrite().then(set, (err) => {
    toast.error(t('settings.mcp.githubWrite.loadFailed', { detail: err instanceof Error ? err.message : String(err) }))
  })
}

/** GitHub writes change things outside this machine, so the box is live only at Read and control. */
export function githubWriteDisabled(access: McpAccess): boolean {
  return access !== 'control'
}

/** Shows `next` at once, saves it, and puts `prev` back with a toast when the save fails. */
export function saveMcpGithubWrite(
  next: boolean,
  prev: boolean,
  set: (v: boolean) => void,
  t: (key: MessageKey, params?: MessageParams) => string
): Promise<void> {
  set(next)
  return window.api.settings.setMcpGithubWrite(next).catch((err) => {
    set(prev)
    toast.error(t('settings.mcp.githubWrite.saveFailed', { detail: err instanceof Error ? err.message : String(err) }))
  })
}

/** A registration line onto the clipboard, or a toast when the clipboard refuses it. */
export function copyLine(line: string, t: (key: MessageKey, params?: MessageParams) => string): Promise<void> {
  return navigator.clipboard.writeText(line).catch((err) => {
    toast.error(t('settings.mcp.copyFailed', { detail: err instanceof Error ? err.message : String(err) }))
  })
}

/** The client a registration row can register with from here; Cursor has no CLI to do it, so its row
 *  stays copy only. */
export function mcpClientFor(client: McpRegistrationLine['client']): McpClient | null {
  return client === 'Claude Code' ? 'claude' : client === 'Codex' ? 'codex' : null
}

export type RegisterView = { kind: 'label'; text: MessageKey } | { kind: 'button'; text: MessageKey; disabled: boolean }

/** What sits beside Copy for one client: nothing until its status is read, a label once Astera is
 *  registered with the same command, otherwise a button (disabled while it runs or when the client's
 *  CLI is not installed). */
export function registerViewFor(status: McpClientStatus | undefined, busy: boolean): RegisterView | null {
  if (status === undefined) return null
  if (busy) return { kind: 'button', text: 'settings.mcp.client.registering', disabled: true }
  switch (status.state) {
    case 'registered':
      return { kind: 'label', text: 'settings.mcp.client.registered' }
    case 'different':
      return { kind: 'button', text: 'settings.mcp.client.registerAgain', disabled: false }
    case 'absent':
      return { kind: 'button', text: 'settings.mcp.client.register', disabled: false }
    case 'not-installed':
      return { kind: 'button', text: 'settings.mcp.client.notInstalled', disabled: true }
  }
}

/** Each client's registration status into `set`, or a toast when it cannot be read; the rows then
 *  show Copy alone. */
export function loadMcpClients(
  set: (s: Record<McpClient, McpClientStatus>) => void,
  t: (key: MessageKey, params?: MessageParams) => string
): Promise<void> {
  return window.api.mcpClients.status().then(set, (err) => {
    toast.error(t('settings.mcp.client.loadFailed', { detail: err instanceof Error ? err.message : String(err) }))
  })
}

/** Registers Astera with `client` through its CLI (main/mcpClients.ts), says how it went, and reads
 *  the status again either way. */
export async function registerClient(
  client: McpClient,
  name: string,
  t: (key: MessageKey, params?: MessageParams) => string,
  refresh: () => Promise<void>
): Promise<void> {
  const r = await window.api.mcpClients
    .register(client)
    .catch((err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }))
  if (r.ok) toast.success(t('settings.mcp.client.done', { client: name }))
  else toast.error(t('settings.mcp.client.failed', { client: name, detail: r.message }))
  await refresh()
}

/** What goes under the registration hint: nothing while the CLI status is unread, a hint to install
 *  the command first while it is not installed (a line naming a file that is not there cannot run),
 *  and once it is, the lines with the installed command by its full path (mcpRegistration.ts). */
export function registrationFor(
  status: CliInstallStatus | null,
  platform: string
): McpRegistrationLine[] | 'install-first' | null {
  if (status === null) return null
  if (!status.installed) return 'install-first'
  return mcpRegistrationLines({ platform, shimPath: shimPathFor({ platform, dir: status.dir }) })
}

/** MCP access (MCP design M5): what an MCP client may do through `astera mcp serve`. The Host reads
 *  the saved value on every call, so the change applies to clients already connected.
 *
 *  `cliStatus` is the value CliSettings read and keeps after Install and Uninstall (App.tsx passes it
 *  on), so the lines follow those buttons without a second read. */
export function McpSettings({ cliStatus }: { cliStatus: CliInstallStatus | null }): React.JSX.Element {
  const { t } = useI18n()
  const registration = registrationFor(cliStatus, window.api.platform)
  const [access, setAccess] = useState<McpAccess>('control')
  const [sessions, setSessions] = useState(false)
  const [githubWrite, setGithubWrite] = useState(false)

  useEffect(() => {
    void loadMcpAccess(setAccess, t)
    void loadMcpSessions(setSessions, t)
    void loadMcpGithubWrite(setGithubWrite, t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once on mount, as before; a language change must not re-read over a choice in flight
  }, [])

  // Which clients already have Astera, read once the lines show (the CLI is installed) and again
  // after Install moves them; reading never runs the server (core/install/mcpClients.ts).
  const [clients, setClients] = useState<Record<McpClient, McpClientStatus> | null>(null)
  const [registering, setRegistering] = useState<McpClient | null>(null)
  const linesShown = Array.isArray(registration)
  const refreshClients = (): Promise<void> => loadMcpClients(setClients, t)
  useEffect(() => {
    if (linesShown) void refreshClients()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the lines, not the language
  }, [linesShown, cliStatus?.dir])

  // Groups as direct children of the tab's .settings-stack, so the stack's gap separates the
  // access setting, the sessions and GitHub settings and the registration lines like neighbouring features.
  return (
    <>
      <div className="settings-group">
        <div className="settings-row">
          <span>{t('settings.mcp.label')}</span>
          <Select
            items={[
              { value: 'off', label: t('settings.mcp.off') },
              { value: 'read', label: t('settings.mcp.read') },
              { value: 'control', label: t('settings.mcp.control') }
            ]}
            value={access}
            onChange={(v) => {
              const next = v as McpAccess
              const prev = access
              setAccess(next)
              void window.api.settings.setMcpAccess(next).catch((err) => {
                setAccess(prev)
                toast.error(t('settings.mcp.saveFailed', { detail: err instanceof Error ? err.message : String(err) }))
              })
            }}
            ariaLabel={t('settings.mcp.label')}
          />
        </div>
        <span className="settings-hint">{t('settings.mcp.hint')}</span>
      </div>
      <div className="settings-group">
        <label className="settings-row">
          <span>{t('settings.mcp.sessions.label')}</span>
          <input
            type="checkbox"
            checked={sessions}
            disabled={sessionsDisabled(access)}
            onChange={(e) => void saveMcpSessions(e.target.checked, sessions, setSessions, t)}
          />
        </label>
        <span className="settings-hint">{t('settings.mcp.sessions.hint')}</span>
      </div>
      <div className="settings-group">
        <label className="settings-row">
          <span>{t('settings.mcp.githubWrite.label')}</span>
          <input
            type="checkbox"
            checked={githubWrite}
            disabled={githubWriteDisabled(access)}
            onChange={(e) => void saveMcpGithubWrite(e.target.checked, githubWrite, setGithubWrite, t)}
          />
        </label>
        <span className="settings-hint">{t('settings.mcp.githubWrite.hint')}</span>
      </div>
      {registration !== null && (
        <div className="settings-group">
          {/* The registration line for each client, in this platform's form (mcpRegistration.ts). */}
          {registration === 'install-first' && <span className="settings-hint">{t('settings.mcp.installFirst')}</span>}
          {Array.isArray(registration) && (
            <>
              <span className="settings-hint">{t('settings.mcp.register')}</span>
              {registration.map(({ client, line }) => {
                const id = mcpClientFor(client)
                const view = id === null ? null : registerViewFor(clients?.[id], registering === id)
                return (
                  <div key={client} className="cli-path-hint">
                    <span className="mcp-register-client">{client}</span>
                    <code>{line}</code>
                    <button onClick={() => void copyLine(line, t)}>{t('settings.cli.copy')}</button>
                    {/* Runs the client's CLI only when pressed (main/mcpClients.ts). */}
                    {id !== null && view?.kind === 'label' && <span className="mcp-register-state">{t(view.text)}</span>}
                    {id !== null && view?.kind === 'button' && (
                      <button
                        disabled={view.disabled || registering !== null}
                        title={clients?.[id].detail}
                        onClick={() => {
                          setRegistering(id)
                          void registerClient(id, client, t, refreshClients).finally(() => setRegistering(null))
                        }}
                      >
                        {t(view.text)}
                      </button>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </>
  )
}
