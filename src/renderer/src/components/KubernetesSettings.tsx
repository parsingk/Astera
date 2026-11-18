import { useEffect, useState } from 'react'
import { Plus, RefreshCw, X } from 'lucide-react'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

type Check = Awaited<ReturnType<typeof window.api.kube.recheck>>

/** The Kubernetes pane of the settings modal: which kubectl runs, and which extra kubeconfig files are merged in.
 *  Buttons are icons with tooltips, as everywhere in the Kubernetes feature. */
export function KubernetesSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [check, setCheck] = useState<Check | null>(null) // null = a check is in flight
  const [override, setOverride] = useState<string | null>(null) // what is stored
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<string[]>([])

  const recheck = async (): Promise<void> => {
    setCheck(null)
    try {
      setCheck(await window.api.kube.recheck())
    } catch (err) {
      setCheck({ ok: false, stderr: err instanceof Error ? err.message : String(err) })
    }
  }

  useEffect(() => {
    void window.api.settings.getKubectlPath().then((p) => {
      setOverride(p)
      setDraft(p ?? '')
    })
    void window.api.settings.getKubeconfigFiles().then(setFiles)
    void recheck()
  }, [])

  const fail = (err: unknown): void => {
    toast.error(t('kube.settings.saveFailed', { detail: err instanceof Error ? err.message : String(err) }))
  }

  const saveDraft = (): Promise<void> => saveOverride(draft.trim() === '' ? null : draft.trim())

  const saveOverride = async (value: string | null): Promise<void> => {
    if (value === override) return
    try {
      await window.api.settings.setKubectlPath(value)
    } catch (err) {
      fail(err)
      return
    }
    setOverride(value)
    setDraft(value ?? '')
    await recheck()
  }

  const saveFiles = async (next: string[]): Promise<void> => {
    try {
      await window.api.settings.setKubeconfigFiles(next)
      setFiles(next)
    } catch (err) {
      fail(err)
    }
  }

  const addFile = async (): Promise<void> => {
    const picked = await window.api.system.pickFile()
    if (picked === null || files.includes(picked)) return
    await saveFiles([...files, picked])
  }

  const status =
    check === null
      ? '…'
      : check.ok
        ? [check.path, check.version].filter((s) => s !== '').join(' · ')
        : check.errorCode === 'ENOENT'
          ? t('kube.settings.notFound')
          : t('kube.settings.error', { detail: check.stderr })

  return (
    <>
      <div className="settings-row">
        <span>{t('kube.settings.status')}</span>
        <span>{status}</span>
        <button type="button" disabled={check === null} title={t('kube.settings.recheck')} aria-label={t('kube.settings.recheck')} onClick={() => void recheck()}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="settings-row">
        <span>{t('kube.settings.override')}</span>
        <input
          type="text"
          value={draft}
          placeholder={check?.ok ? check.path : 'kubectl'}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveDraft()
          }}
          onBlur={() => void saveDraft()}
        />
        <button
          type="button"
          disabled={override === null && draft === ''}
          title={t('kube.settings.clearOverride')}
          aria-label={t('kube.settings.clearOverride')}
          onClick={() => void saveOverride(null)}
        >
          <X size={14} />
        </button>
      </div>
      <div className="settings-row">
        <span>{t('kube.settings.files')}</span>
        <button type="button" title={t('kube.settings.addFile')} aria-label={t('kube.settings.addFile')} onClick={() => void addFile()}>
          <Plus size={14} />
        </button>
      </div>
      {files.length === 0 && <span className="settings-hint">{t('kube.settings.filesNone')}</span>}
      {files.map((f) => (
        <div className="settings-row" key={f}>
          <code title={f}>{f}</code>
          <button
            type="button"
            title={t('kube.settings.removeFile', { path: f })}
            aria-label={t('kube.settings.removeFile', { path: f })}
            onClick={() => void saveFiles(files.filter((x) => x !== f))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <span className="settings-hint">{t('kube.settings.filesHint')}</span>
    </>
  )
}
