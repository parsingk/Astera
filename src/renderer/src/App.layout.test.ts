import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// App needs a DOM; its layout wiring is pinned by its text, as the palette's is. What can come back and how a tree is
// rebuilt is decided in core/panes/savedLayout.ts and lib/restoreLayout.ts, which have their own tests.
const here = path.dirname(fileURLToPath(import.meta.url))
const app = readFileSync(path.join(here, 'App.tsx'), 'utf8')
const css = readFileSync(path.join(here, 'styles.css'), 'utf8')

describe('the window layout (spec W3)', () => {
  it('reads the layout once before the first paint and opens the panels as they were', () => {
    expect(app).toMatch(/const \[savedAtStart\] = useState\(readLayout\)/)
    expect(app).toMatch(/const \[sidebarOpen, setSidebarOpen\] = useState\(\(\) => savedAtStart\?\.panels\.sidebar\.open \?\? true\)/)
    expect(app).toMatch(/const \[explorerOpen, setExplorerOpen\] = useState\(\(\) => savedAtStart\?\.panels\.sidebar\.view === 'explorer'\)/)
    expect(app).toMatch(/const \[jobsOpen, setJobsOpen\] = useState\(\(\) => savedAtStart\?\.panels\.sidebar\.view === 'jobs'\)/)
    expect(app).toMatch(/const \[hiwOpen, setHiwOpen\] = useState\(\(\) => savedAtStart\?\.panels\.sidebar\.view === 'understanding'\)/)
    expect(app).toMatch(/const \[runPanelOpen, setRunPanelOpen\] = useState\(\(\) => savedAtStart\?\.panels\.bottom\.open \?\? false\)/)
    expect(app).toMatch(/const \[bottomTab, setBottomTab\] = useState<string>\(\(\) => savedAtStart\?\.panels\.bottom\.tab \?\? 'run'\)/)
  })

  it('rebuilds the tree with what main says can come back, then adds the live sessions it did not name', () => {
    // Final review C1, I1: the checks wait for the Host's take back (the project guard counts the sessions' folders), and
    // the list is asked after the checks, so it is fresh when applied (screen re-check: a file of a project known only
    // through a session's folder was dropped when checked before the take back)
    expect(app).toMatch(/void window\.api\.sessions\s*\.list\(\{ afterTakeBack: true \}\)\s*\.catch\(\(\): SessionInfo\[\] => \[\]\)\s*\.then\(\(\) => checkSavedTabs\(savedAtStart\)\)\s*\.then\(\(checked\) =>\s*window\.api\.sessions\s*\.list\(\)/)
    expect(app).toMatch(/const keep = keepSavedTab\(savedAtStart, checked, new Set\(\[\.\.\.listed, \.\.\.arrived\.map\(\(s\) => s\.id\)\]\)\)/)
    expect(app).toMatch(/restoreTree\(savedAtStart\?\.tree \?\? null, savedAtStart\?\.active \?\? -1, keep\)/)
    // A session the layout did not name joins the first group without taking its active tab
    expect(app).toMatch(/const unnamed = list\.filter\(\(s\) => !named\.has\(sessionTab\(s\.id\)\)\)/)
  })

  // Final review C1: nothing that reached the window while the restore waited is lost
  it('merges what the window drew meanwhile, and keeps session rows that arrived after the list', () => {
    expect(app).toMatch(/placeAppTabs\(mergeTabs\(root, layoutRef\.current\), openSessionIds\(mirrorsRef\.current\), paneId\)/)
    expect(app).toMatch(/const arrived = sessionsRef\.current\.filter\(\(s\) => !listed\.has\(s\.id\)\)\s*setSessions\(\[\.\.\.list, \.\.\.arrived\]\)/)
  })

  // Final review I2, M8: StrictMode's second run applies once; a list that cannot be had still restores the rest
  it('applies the restore once, and restores without a session list', () => {
    expect(app).toMatch(/\.then\(\(\{ checked, all \}\) => \{\s*if \(!restoreLive\) return\s*layoutRestoredRef\.current = true/)
    expect(app).toMatch(/return \(\) => \{\s*restoreLive = false/)
    expect(app).toMatch(/\.catch\(\(\): SessionInfo\[\] => \[\]\)/)
  })

  it('brings back each kept tab’s row once, holding previews and cluster objects', () => {
    expect(app).toMatch(/if \(file && !fileTabsRef\.current\.some\(\(t\) => t\.id === id\)\) loadFileTab\(id, file\.path, file\.projectRoot\)/)
    expect(app).toMatch(/setRecordTabs\(\(prev\) => \[\.\.\.prev, \.\.\.records\.filter\(\(r\) => !prev\.some\(\(x\) => x\.id === r\.id\)\)\]\)/)
    expect(app).toMatch(/setBrowserTabs\(\(prev\) => \[\.\.\.prev, \.\.\.browsers\.filter\(\(b\) => !prev\.some\(\(x\) => x\.id === b\.id\)\)\]\)/)
    expect(app).toMatch(/setHeldTabs\(new Set\(/)
    // openFile goes through the same loader
    expect(app).toMatch(/const loadFileTab = \(/)
  })

  // Final review I3: an object opened again is shown, and a held tab that left the tree is forgotten
  it('lets go of a held cluster object opened again, and forgets a held tab that was closed', () => {
    expect(app).toMatch(/const openKubeObject = \(ref: ObjectRef\): void => \{\s*releaseTab\(kubeTab\(ref\)\)/)
    expect(app).toMatch(/const next = new Set\(\[\.\.\.prev\]\.filter\(\(id\) => inTree\.has\(id\)\)\)/)
    expect(app).not.toMatch(/like every non-session tab it is not restored after a restart/)
  })

  // Final review I4: a drag starts from the height on screen, inside the window's bound
  it('drags the bottom panel from the height it is drawn at', () => {
    expect(app).toMatch(/const startH = drawnPanelHeight\(\)/)
    expect(app).toMatch(/Math\.min\(800, window\.innerHeight - 200, Math\.max\(120, startH \+ \(startY - y\)\)\)/)
    expect(app).toMatch(/kubeRailClick\(\{ panelOpen: runPanelOpen, shownTab: bottomTabShown, height: drawnPanelHeight\(\) \}\)/)
  })

  // Final review I5: the cluster view restored on screen reads nothing until asked
  it('holds a restored cluster view until the person asks for it', () => {
    expect(app).toMatch(/const \[kubeHeld, setKubeHeld\] = useState\(\(\) => savedAtStart\?\.panels\.bottom\.open === true && savedAtStart\.panels\.bottom\.tab === 'kube'\)/)
    expect(app).toMatch(/\}\) && !kubeHeld\s*const cluster = useClusterView/)
    expect(app).toMatch(/kubeHeld \? \(\s*<div className="kube-cluster">\s*<div className="kube-segment-bar">\{switcher\}<\/div>\s*<HeldTab name=\{t\('kube\.log\.tab'\)\} onLoad=\{\(\) => setKubeHeld\(false\)\} \/>/)
    // Released by the rail, the Kubernetes tab and a preset that shows it
    expect(app).toMatch(/const kubeRail = \(\): void => \{\s*setKubeHeld\(false\)/)
    expect(app).toMatch(/onSelectTab=\{\(tab\) => \{\s*if \(tab === 'kube'\) setKubeHeld\(false\)\s*setBottomTab\(tab\)/)
    expect(app).toMatch(/if \(p\.bottom\.open && p\.bottom\.tab === 'kube'\) setKubeHeld\(false\)/)
  })

  // Final review M3: DevOps' tall panel is for that opening, like the rail's; the dragged height stays the person's
  it('opens DevOps tall without storing the height', () => {
    expect(app).toMatch(/if \(p\.bottomHeight === 'tall'\) setRunPanelHeight\(Math\.min\(800, Math\.max\(runPanelHeight, Math\.round\(window\.innerHeight \* 0\.45\)\)\)\)/)
  })

  it('saves only after the restore, a moment after the last change, and at once when the page goes', () => {
    expect(app).toMatch(/layoutRestoredRef\.current = true/)
    expect(app).toMatch(/if \(!layoutRestoredRef\.current\) return\s*const timer = setTimeout\(\(\) => writeLayout\(layoutRecordRef\.current\(\)\), 300\)/)
    expect(app).toMatch(/window\.addEventListener\('pagehide', flush\)/)
    expect(app).toMatch(/browserTabs\s*\.filter\(\(b\) => !b\.agentSessionId\)/)
  })

  it('keeps the bottom panel and the sidebar inside a smaller window', () => {
    expect(css).toMatch(/\.run-panel \{[^}]*max-height: calc\(100vh - 200px\)/)
    expect(css).toMatch(/\.sidebar \{[^}]*max-width: calc\(100vw - 360px\)/)
  })
})
