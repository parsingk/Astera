import { useI18n } from '../../i18n/I18nProvider'

/** kubectl was not found: the notice and its link to the setting where its path is set. The manifests toolbar and the
 *  Kubernetes tab's Cluster segment both show it, each in a row of its own. */
export function KubectlMissingNotice({ onOpenSettings }: { onOpenSettings(): void }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <span className="kube-notice">{t('kube.toolbar.kubectlMissing')}</span>
      <button type="button" className="kube-link" onClick={onOpenSettings}>
        {t('kube.toolbar.openSettings')}
      </button>
    </>
  )
}
