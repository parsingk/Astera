import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// App needs a DOM; how it reads and applies the workspace feature switches (Phase 1 gate) is pinned by its text. The
// switches' narrowing is core/settings/workspaceFeatures.ts, tested on its own.
const here = path.dirname(fileURLToPath(import.meta.url))
const app = readFileSync(path.join(here, 'App.tsx'), 'utf8')

describe('the workspace feature switches in App (Phase 1 gate)', () => {
  it('holds them as null until main answers, and reads them once at start', () => {
    expect(app).toMatch(/const \[workspaceFeatures, setWorkspaceFeaturesState\] = useState<WorkspaceFeatures \| null>\(null\)/)
    expect(app).toMatch(/const setWorkspaceFeatures = useMemo\(\(\) => writeThrough\(workspaceFeaturesRef, setWorkspaceFeaturesState\), \[\]\)/)
    expect(app).toMatch(/void window\.api\.settings\s*\.getWorkspaceFeatures\(\)\s*\.then\(setWorkspaceFeatures\)\s*\.catch\(\(\) => setWorkspaceFeatures\(\{ \.\.\.WORKSPACE_FEATURES_DEFAULTS \}\)\)/)
  })

  it('saves a switch at once and puts back only that one when the save fails', () => {
    expect(app).toMatch(/const toggleWorkspaceFeature = \(key: keyof WorkspaceFeatures, next: boolean\): void => \{/)
    expect(app).toMatch(/void window\.api\.settings\.setWorkspaceFeatures\(updated\)\.catch\(\(err\) => \{\s*setWorkspaceFeatures\(\(f\) => \(f \? \{ \.\.\.f, \[key\]: !next \} : f\)\)\s*toast\.error\(\s*t\('settings\.workspace\.saveFailed'/)
  })

  it('draws them in the General tab, under the default session kind', () => {
    const general = app.indexOf("settingsTab === 'general' && (")
    const kindHint = app.indexOf("{t('settings.defaultKind.hint')}", general)
    const pane = app.indexOf('<WorkspaceFeatureSettings value={workspaceFeatures} onToggle={toggleWorkspaceFeature} />', general)
    const cli = app.indexOf("settingsTab === 'cli' && (", general)
    expect(kindHint).toBeGreaterThan(general)
    expect(pane).toBeGreaterThan(kindHint)
    expect(pane).toBeLessThan(cli)
  })
})
