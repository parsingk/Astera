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
    expect(app).toMatch(/Promise\.all\(\[window\.api\.sessions\.list\(\), checkSavedTabs\(savedAtStart\)\]\)/)
    expect(app).toMatch(/const keep = keepSavedTab\(savedAtStart, checked, new Set\(list\.map\(\(s\) => s\.id\)\)\)/)
    expect(app).toMatch(/restoreTree\(savedAtStart\?\.tree \?\? null, savedAtStart\?\.active \?\? -1, keep\)/)
    // A session the layout did not name joins the first group without taking its active tab
    expect(app).toMatch(/const unnamed = list\.filter\(\(s\) => !named\.has\(sessionTab\(s\.id\)\)\)/)
  })

  it('brings back each kept tab’s row, holding previews and cluster objects', () => {
    expect(app).toMatch(/if \(file\) loadFileTab\(id, file\.path, file\.projectRoot\)/)
    expect(app).toMatch(/setHeldTabs\(new Set\(/)
    // openFile goes through the same loader
    expect(app).toMatch(/const loadFileTab = \(/)
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
