import { useEffect, useState } from 'react'
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { McpAccess } from '../../../core/types'
import { mcpRegistrationLines } from '../../../core/install/mcpRegistration'
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

/** MCP access (MCP design M5): what an MCP client may do through `astera mcp serve`. The Host reads
 *  the saved value on every call, so the change applies to clients already connected. */
export function McpSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [access, setAccess] = useState<McpAccess>('control')

  useEffect(() => {
    void loadMcpAccess(setAccess, t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once on mount, as before; a language change must not re-read over a choice in flight
  }, [])

  return (
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
      {/* The registration line for each client, in this platform's form (mcpRegistration.ts). */}
      <span className="settings-hint">{t('settings.mcp.register')}</span>
      {mcpRegistrationLines(window.api.platform).map(({ client, line }) => (
        <div key={client} className="cli-path-hint">
          <span className="mcp-register-client">{client}</span>
          <code>{line}</code>
          <button onClick={() => void navigator.clipboard.writeText(line)}>{t('settings.cli.copy')}</button>
        </div>
      ))}
    </div>
  )
}
