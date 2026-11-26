import type { WorkspaceFeatures } from '../../../core/settings/workspaceFeatures'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'

/** The features that act without a key, in the order a person meets them: the layout that comes back at start, the
 *  Problems tab, the buttons that send a piece of the workbench to an agent (the Phase 1 three), the Tests tab, and the
 *  language servers' problems (Phase 3 Part 3). */
const SWITCHES = [
  {
    key: 'layoutMemory',
    label: 'settings.workspace.layoutMemory',
    hint: 'settings.workspace.layoutMemoryHint'
  },
  {
    key: 'problemsTab',
    label: 'settings.workspace.problemsTab',
    hint: 'settings.workspace.problemsTabHint'
  },
  {
    key: 'contextBridge',
    label: 'settings.workspace.contextBridge',
    hint: 'settings.workspace.contextBridgeHint'
  },
  {
    key: 'testsTab',
    label: 'settings.workspace.testsTab',
    hint: 'settings.workspace.testsTabHint'
  },
  {
    key: 'languageServers',
    label: 'settings.workspace.languageServers',
    hint: 'settings.workspace.languageServersHint'
  }
] as const satisfies readonly { key: keyof WorkspaceFeatures; label: MessageKey; hint: MessageKey }[]

/** The workspace feature switches in Settings > General (the spec's Phase 1 gate). App owns the value, because the
 *  layout, the bottom panel and the run views all read it; this only draws it. */
export function WorkspaceFeatureSettings({
  value,
  onToggle
}: {
  value: WorkspaceFeatures | null
  onToggle: (key: keyof WorkspaceFeatures, next: boolean) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <span className="settings-hint">{t('settings.workspace.hint')}</span>
      {SWITCHES.map(({ key, label, hint }) => (
        <div className="settings-group" key={key}>
          <label className="settings-row">
            <span>{t(label)}</span>
            <input
              type="checkbox"
              // Unchecked until main answers: a switch that flips itself a moment after the tab opens reads as a
              // setting that changed (NotificationSettings does the same)
              checked={value?.[key] ?? false}
              disabled={value === null}
              onChange={(e) => onToggle(key, e.target.checked)}
            />
          </label>
          <span className="settings-hint">{t(hint)}</span>
        </div>
      ))}
    </>
  )
}
