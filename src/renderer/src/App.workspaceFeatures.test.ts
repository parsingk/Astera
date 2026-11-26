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
    // Final review M1: one read, shared with the restore
    expect(app).toMatch(/const \[featuresAsked\] = useState\(\(\) =>\s*window\.api\.settings\.getWorkspaceFeatures\(\)\.catch\(\(\) => \(\{ \.\.\.WORKSPACE_FEATURES_DEFAULTS \}\)\)\s*\)/)
    expect(app).toMatch(/void featuresAsked\.then\(setWorkspaceFeatures\)/)
    expect(app).not.toMatch(/getWorkspaceFeatures\(\)[\s\S]{0,40}getWorkspaceFeatures\(\)/)
    expect(app.match(/window\.api\.settings\.getWorkspaceFeatures\(\)/g)).toHaveLength(1)
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

describe('layout memory off (Phase 1 gate)', () => {
  // Asked beside the Host's take back, so it adds no wait; a failed read is the default, on
  it('restores nothing and deletes the saved layout while it is off', () => {
    expect(app).toMatch(/\.then\(\(\) => featuresAsked\)\s*\.then\(async \(features\) => \{\s*if \(!features\.layoutMemory\) clearLayout\(\)\s*const saved = features\.layoutMemory \? savedAtStart : null/)
    // Final review M1: turned off while the restore waited, nothing comes back
    expect(app).toMatch(/\.then\(\(\{ saved: savedThen, checked, all \}\) => \{\s*if \(!restoreLive\) return\s*layoutRestoredRef\.current = true\s*(?:\/\/[^\n]*\n\s*)*const saved = workspaceFeaturesRef\.current\?\.layoutMemory === false \? null : savedThen/)
    // Final review M2: a record left in storage while it is off does not keep the panels it opened at first paint
    expect(app).toMatch(/if \(savedAtStart && !saved\) \{\s*applyPanels\(presetPanels\('default'\)\)\s*setKubeHeld\(false\)\s*\}/)
  })

  it('saves only while it is on, and saves the screen as it is when it is turned on', () => {
    expect(app).toMatch(/if \(!layoutRestoredRef\.current \|\| workspaceFeaturesRef\.current\?\.layoutMemory !== true\) return\s*const timer = setTimeout\(\(\) => \{\s*if \(workspaceFeaturesRef\.current\?\.layoutMemory === true\) writeLayout\(layoutRecordRef\.current\(\)\)\s*\}, 300\)/)
    expect(app).toMatch(/\}, \[workspaceFeatures\?\.layoutMemory, layout, activePaneId, sidebarOpen, explorerOpen, jobsOpen, hiwOpen, runPanelOpen, bottomTab, fileTabs, recordTabs, browserTabs, pluginTabs\]\)/)
    expect(app).toMatch(/const flush = \(\): void => \{\s*if \(layoutRestoredRef\.current && workspaceFeaturesRef\.current\?\.layoutMemory === true\) writeLayout\(layoutRecordRef\.current\(\)\)/)
  })

  it('deletes the saved layout when it is turned off', () => {
    expect(app).toMatch(/setWorkspaceFeatures\(updated\)\s*if \(key === 'layoutMemory' && !next\) clearLayout\(\)/)
  })
})

describe('the Problems tab off (Phase 1 gate)', () => {
  it('draws the tab only on an explicit on, and asks main for problems only then', () => {
    expect(app).toMatch(/problemsEnabled=\{problemsOn\}/)
    // Final review I1: the shown tab falls back to Run while the Problems tab is off, whoever asked for it
    expect(app).toMatch(/shownBottomTab\(\{\s*wanted: bottomTab,\s*runAvailable,\s*kubeAvailable,\s*problemsAvailable: workspaceFeatures\?\.problemsTab === true,\s*testsAvailable: workspaceFeatures\?\.testsTab === true,\s*terminalIds: terminals\.map\(\(x\) => x\.id\)\s*\}\)/)
    expect(app).toMatch(/const problemsOn = workspaceFeatures\?\.problemsTab === true/)
    expect(app).toMatch(/useEffect\(\(\) => \{\s*if \(!problemsOn\) return\s*if \(!currentProject\) \{\s*setProblems\(\[\]\)/)
  })

  // A bottom panel saved on the Problems tab opens on Run while the tab is off
  it('moves the bottom panel off the Problems tab while it is off', () => {
    expect(app).toMatch(/if \(workspaceFeatures\?\.problemsTab === false\) setBottomTab\(\(cur\) => \(cur === 'problems' \? 'run' : cur\)\)\s*\}, \[workspaceFeatures\?\.problemsTab\]\)/)
  })

  // Phase 3 Part 2: the Tests tab follows the Problems tab's rules
  it('asks main for test results only while the Tests tab is on, and moves the bottom panel off it while it is off', () => {
    expect(app).toMatch(/testsEnabled=\{testsOn\}/)
    expect(app).toMatch(/const testsOn = workspaceFeatures\?\.testsTab === true/)
    expect(app).toMatch(/useEffect\(\(\) => \{\s*if \(!testsOn\) return\s*if \(!currentProject\) \{\s*setTestResults\(\[\]\)/)
    expect(app).toMatch(/if \(workspaceFeatures\?\.testsTab === false\) setBottomTab\(\(cur\) => \(cur === 'tests' \? 'run' : cur\)\)\s*\}, \[workspaceFeatures\?\.testsTab\]\)/)
  })

  // Blocked as turned off: its key goes on to the focused element (keyRouting.ts) and the palette leaves it out
  it('blocks its action as turned off, and the palette leaves out every action turned off', () => {
    expect(app).toMatch(/'problems\.open': \{\s*blockedBy: \(\) =>\s*workspaceFeaturesRef\.current\?\.problemsTab !== true \? 'action\.blocked\.featureOff'/)
    expect(app).toMatch(/entries=\{\[\s*\.\.\.ACTIONS\.filter\(\(a\) => a\.id !== 'palette\.open'\)\.flatMap\(\(a\) => \{\s*const state = actionRegistry\.state\(a\.id\)\s*(?:\/\/[^\n]*\n\s*)*if \(!state\.ok && state\.reason === 'action\.blocked\.featureOff'\) return \[\]/)
  })
})

describe('sending to an agent off (Phase 1 gate)', () => {
  it('hides the run rail button and the diff hunk button on anything but an explicit on', () => {
    expect(app).toMatch(/const contextOn = workspaceFeatures\?\.contextBridge === true/)
    expect(app).toMatch(/contextEnabled=\{contextOn\}/)
    expect(app).toMatch(/\.\.\.\(contextOn\s*\?\s*\{\s*onDraftRepair: \(file: string, diff: string, rowIndex: number\) => openRepairDraft\(openRun, file, diff, rowIndex\)\s*\}\s*: \{\}\)/)
  })

  it('blocks the selection command as turned off, so the palette leaves it out', () => {
    expect(app).toMatch(/'context\.attachSelection': \{\s*blockedBy: \(\) =>\s*workspaceFeaturesRef\.current\?\.contextBridge !== true \? 'action\.blocked\.featureOff'/)
  })
})
