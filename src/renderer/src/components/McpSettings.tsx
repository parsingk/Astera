import { useEffect, useState } from 'react'
import type { McpAccess } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { Select } from './Select'

/** MCP access (MCP design M5): what an MCP client may do through `astera mcp serve`. The Host reads
 *  the saved value on every call, so the change applies to clients already connected. */
export function McpSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [access, setAccess] = useState<McpAccess>('control')

  useEffect(() => {
    void window.api.settings.getMcpAccess().then(setAccess)
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
    </div>
  )
}
