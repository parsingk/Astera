import { useState } from 'react'
import { HiggsfieldSettings } from './HiggsfieldSettings'
import { pickPlatform, showsPicker, type CreativePlatform } from './creativeHub'

/** One entry per platform. Adding a platform is one line here plus its settings component. */
const PLATFORMS: readonly (CreativePlatform & { Settings: () => React.JSX.Element })[] = [
  { id: 'higgsfield', label: 'Higgsfield', Settings: HiggsfieldSettings }
]

export function CreativeHubSettings(): React.JSX.Element {
  const [chosen, setChosen] = useState<string | null>(null)
  const current = pickPlatform(PLATFORMS, chosen)
  return (
    <div className="settings-stack">
      {showsPicker(PLATFORMS) ? (
        <div className="kind-segmented" role="tablist">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === current?.id}
              className={`segmented${p.id === current?.id ? ' active' : ''}`}
              onClick={() => setChosen(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : (
        current && <div className="settings-field-label">{current.label}</div>
      )}
      {current && <current.Settings key={current.id} />}
    </div>
  )
}
