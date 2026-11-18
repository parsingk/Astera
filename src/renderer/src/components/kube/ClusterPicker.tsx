import { useEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { displayContextName } from '../../../../core/kube/contextName'
import type { KubeContexts } from '../../../../core/kube/types'
import { nextCursor } from '../../../../core/ui/select'
import { useI18n } from '../../i18n/I18nProvider'

export interface ClusterPickerProps {
  contexts: KubeContexts
  selected: string | null
  /** The folder the service would remember the choice for; the default of the folder chooser. */
  rememberFolder: string
  /** Folders a choice may be remembered for, nearest first. Empty hides the "remember" row. */
  rememberChoices: string[]
  projectRoot: string
  onPick(context: string, remember: { folder: string } | null): void
  onUseContext(context: string): void
  onAddKubeconfig(): void
  onOpenSettings(): void
  onClose(): void
}

const PROVIDER_TAG = { eks: 'EKS', gke: 'GKE' } as const

/** Closes a popover on Escape and on a press outside it. */
function useDismiss(onClose: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', key)
    document.addEventListener('mousedown', down)
    return () => {
      document.removeEventListener('keydown', key)
      document.removeEventListener('mousedown', down)
    }
  }, [onClose])
  return ref
}

/** The folder as the chooser shows it: relative to the project root. */
function folderLabel(folder: string, projectRoot: string, rootLabel: string): string {
  const f = folder.split('\\').join('/').replace(/\/+$/, '')
  const r = projectRoot.split('\\').join('/').replace(/\/+$/, '')
  if (f.toLowerCase() === r.toLowerCase()) return rootLabel
  return f.toLowerCase().startsWith(r.toLowerCase() + '/') ? f.slice(r.length + 1) : f
}

/** Picks the cluster a folder's manifests go to (spec 4.4). Remembering the choice is on by default. */
export function ClusterPicker(p: ClusterPickerProps): React.JSX.Element {
  const { t } = useI18n()
  const ref = useDismiss(p.onClose)
  const [query, setQuery] = useState('')
  const [remember, setRemember] = useState(true)
  const [folder, setFolder] = useState(p.rememberChoices.includes(p.rememberFolder) ? p.rememberFolder : (p.rememberChoices[0] ?? ''))
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return p.contexts.contexts.filter(
      (c) => q === '' || c.name.toLowerCase().includes(q) || displayContextName(c.name).short.toLowerCase().includes(q)
    )
  }, [p.contexts.contexts, query])
  const [cursor, setCursor] = useState(() => Math.max(0, shown.findIndex((c) => c.name === p.selected)))
  const canRemember = p.rememberChoices.length > 0

  const pick = (name: string): void => p.onPick(name, canRemember && remember ? { folder } : null)

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => nextCursor(c, shown.length, e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter' && shown.length > 0) {
      e.preventDefault()
      pick(shown[nextCursor(cursor, shown.length, 0)].name)
    }
  }

  return (
    <div className="kube-picker" ref={ref}>
      <input
        className="kube-picker-search"
        autoFocus
        value={query}
        placeholder={t('kube.picker.search')}
        aria-label={t('kube.picker.search')}
        onChange={(e) => {
          setQuery(e.target.value)
          setCursor(0)
        }}
        onKeyDown={onKeyDown}
      />
      <ul className="kube-picker-list" role="listbox">
        {shown.length === 0 && <li className="kube-picker-empty">{t('kube.picker.empty')}</li>}
        {shown.map((c, i) => {
          const d = displayContextName(c.name)
          return (
            <li
              key={c.name}
              role="option"
              aria-selected={c.name === p.selected}
              className={`kube-picker-row${i === nextCursor(cursor, shown.length, 0) ? ' cursor' : ''}`}
              title={c.name}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(c.name)}
            >
              <span className="kube-picker-check-slot">{c.name === p.selected && <Check size={13} className="kube-picker-check" />}</span>
              <span className="kube-picker-name">{d.short}</span>
              {d.detail !== null && <span className="kube-picker-detail">{d.detail}</span>}
              {c.provider !== null && <span className="kube-picker-tag">{PROVIDER_TAG[c.provider]}</span>}
              {c.name === p.contexts.current && <span className="kube-picker-current">{t('kube.picker.current')}</span>}
            </li>
          )
        })}
      </ul>
      {canRemember && (
        <label className="kube-picker-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>{t('kube.picker.remember')}</span>
          <select
            value={folder}
            aria-label={t('kube.picker.rememberFolder')}
            disabled={!remember}
            onChange={(e) => setFolder(e.target.value)}
          >
            {p.rememberChoices.map((f) => (
              <option key={f} value={f}>
                {folderLabel(f, p.projectRoot, t('kube.picker.root'))}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="kube-picker-items">
        {p.selected !== null && (
          <button type="button" className="kube-picker-item" onClick={() => p.onUseContext(p.selected as string)}>
            {t('kube.picker.useContext', { name: displayContextName(p.selected).short })}
          </button>
        )}
        <button type="button" className="kube-picker-item" onClick={p.onAddKubeconfig}>
          {t('kube.picker.addKubeconfig')}
        </button>
        <button type="button" className="kube-picker-item" onClick={p.onOpenSettings}>
          {t('kube.picker.settings')}
        </button>
      </div>
    </div>
  )
}

export interface NamespacePickerProps {
  value: string | null
  onPick(namespace: string): void
  onClose(): void
}

/** The namespace pill's popover: a text field, Enter applies. */
export function NamespacePicker(p: NamespacePickerProps): React.JSX.Element {
  const { t } = useI18n()
  const ref = useDismiss(p.onClose)
  const [text, setText] = useState(p.value ?? '')
  return (
    <div className="kube-picker kube-picker-ns" ref={ref}>
      <input
        className="kube-picker-search"
        autoFocus
        value={text}
        placeholder={t('kube.picker.namespacePlaceholder')}
        aria-label={t('kube.picker.namespacePlaceholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim() !== '') {
            e.preventDefault()
            p.onPick(text.trim())
          }
        }}
      />
    </div>
  )
}
