import { useEffect, useRef, useState } from 'react'
import type { RunConfigType } from '../../../core/run/types'
import type { MessageKey } from '../../../core/i18n'
import { runTypeIcon } from '../../../core/run/typeIcon'
import { useI18n } from '../i18n/I18nProvider'
import { FileIcon } from './FileIcon'

/** Every kind modeled so far, in the order they are offered. Dockerfile/.NET are out of scope until
 *  their own tasks give them a RunConfigType. */
const ALL_TYPES: RunConfigType[] = [
  'shell', 'npm', 'node', 'gradle', 'maven', 'cargo', 'go', 'python', 'pytest', 'compose'
]

/** The ＋ button's popup for picking a new configuration's kind. A search box narrows the list; kinds
 *  already detected in this project (a seed of that kind exists in `configs` — RunConfigManager derives
 *  `detected` from that, since the seed's presence already came from scanning the project's own files)
 *  are grouped above the rest, the same role IntelliJ gives plugin-provided kinds over generic ones. */
export function RunTypePicker({
  detected,
  onPick,
  onClose
}: {
  detected: RunConfigType[]
  onPick: (type: RunConfigType) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    const onDocDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [])

  const label = (ty: RunConfigType): string => t(`run.type.${ty}` as MessageKey)
  const q = query.trim().toLowerCase()
  const matches = (ty: RunConfigType): boolean => q === '' || label(ty).toLowerCase().includes(q) || ty.includes(q)

  const detectedSet = new Set(detected)
  const detectedList = ALL_TYPES.filter((ty) => detectedSet.has(ty) && matches(ty))
  const otherList = ALL_TYPES.filter((ty) => !detectedSet.has(ty) && matches(ty))

  return (
    <div className="rtp-menu" ref={rootRef} role="menu">
      <input
        ref={inputRef}
        type="text"
        className="rtp-search"
        placeholder={t('run.picker.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {detectedList.length > 0 && (
        <>
          <div className="rtp-group">{t('run.picker.detected')}</div>
          {detectedList.map((ty) => (
            <button key={ty} type="button" className="rtp-item" onClick={() => onPick(ty)}>
              <FileIcon {...runTypeIcon(ty)} />
              {label(ty)}
            </button>
          ))}
        </>
      )}
      {otherList.length > 0 && (
        <>
          {detectedList.length > 0 && <div className="rtp-group">{t('run.picker.other')}</div>}
          {otherList.map((ty) => (
            <button key={ty} type="button" className="rtp-item" onClick={() => onPick(ty)}>
              <FileIcon {...runTypeIcon(ty)} />
              {label(ty)}
            </button>
          ))}
        </>
      )}
    </div>
  )
}
