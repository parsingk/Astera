import { useEffect, useState } from 'react'
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { CliInstallStatus, McpAccess } from '../../../core/types'
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

/** A registration line onto the clipboard, or a toast when the clipboard refuses it. */
export function copyLine(line: string, t: (key: MessageKey, params?: MessageParams) => string): Promise<void> {
  return navigator.clipboard.writeText(line).catch((err) => {
    toast.error(t('settings.mcp.copyFailed', { detail: err instanceof Error ? err.message : String(err) }))
  })
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

  useEffect(() => {
    void loadMcpAccess(setAccess, t)
    void loadMcpSessions(setSessions, t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once on mount, as before; a language change must not re-read over a choice in flight
  }, [])

  // Three groups as direct children of the tab's .settings-stack, so the stack's gap separates the
  // access setting, the sessions setting and the registration lines like neighbouring features.
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
      {registration !== null && (
        <div className="settings-group">
          {/* The registration line for each client, in this platform's form (mcpRegistration.ts). */}
          {registration === 'install-first' && <span className="settings-hint">{t('settings.mcp.installFirst')}</span>}
          {Array.isArray(registration) && (
            <>
              <span className="settings-hint">{t('settings.mcp.register')}</span>
              {registration.map(({ client, line }) => (
                <div key={client} className="cli-path-hint">
                  <span className="mcp-register-client">{client}</span>
                  <code>{line}</code>
                  <button onClick={() => void copyLine(line, t)}>{t('settings.cli.copy')}</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  )
}
