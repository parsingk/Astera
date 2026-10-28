// The agent workspace e2e fixture (desktop.e2e.test.ts, desktop.linux.e2e.test.ts and
// desktop.mac.e2e.test.ts): one window whose page records what reaches it in window.events, which the
// test reads over its own CDP connection.
const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Astera workspace fixture</title></head><body>
<textarea id="t"></textarea>
<button id="b" onclick="document.getElementById('out').textContent = 'clicked'">Click</button>
<div id="out"></div>
<div id="src" draggable="true" style="width:80px;height:40px;background:#88f">drag me</div>
<div id="dst" style="width:200px;height:80px;background:#8f8">drop here</div>
<div id="drop" style="width:200px;height:80px;background:#f88">files here</div>
<script>
window.events = []
const note = (e) => window.events.push(e)
// What the pointer did, for the e2e to print when a drag does not start: the event, where, which
// buttons were down, and whether it came from real input (CDP input counts as real too).
window.mouseLog = []
for (const type of ['pointerdown', 'mousedown', 'mousemove', 'mouseup', 'mouseleave', 'dragstart', 'dragend', 'drop'])
  document.addEventListener(type, (e) => { if (window.mouseLog.length < 300) window.mouseLog.push([Math.round(performance.now()), type, Math.round(e.clientX), Math.round(e.clientY), e.buttons, e.isTrusted]) }, true)
const t = document.getElementById('t')
t.addEventListener('paste', (e) => note({ kind: 'paste', trusted: e.isTrusted, text: e.clipboardData.getData('text/plain') }))
document.getElementById('src').addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'card-1'))
const dst = document.getElementById('dst')
dst.addEventListener('dragover', (e) => e.preventDefault())
dst.addEventListener('drop', (e) => { e.preventDefault(); note({ kind: 'drop', text: e.dataTransfer.getData('text/plain') }) })
const drop = document.getElementById('drop')
drop.addEventListener('dragover', (e) => e.preventDefault())
drop.addEventListener('drop', (e) => { e.preventDefault(); note({ kind: 'files', names: Array.from(e.dataTransfer.files).map((f) => f.name) }) })
</script></body></html>`

// On macOS the workspace launches the app in the background and passes ASTERA_APP_CHROMIUM_FLAGS
// (Linux and macOS design, L3; plan ruling R5): the fixture then never shows its window, and its page
// still renders for CDP. Windows and Linux do not set it, so the window shows on their hidden desktop.
const hidden = Boolean(process.env.ASTERA_APP_CHROMIUM_FLAGS)

// --detached-child=<file>: a child started detached, the way a dev Astera starts its Host, its pid
// written to <file>. --detached-orphan=<file>: the same through a parent that exits at once, so the
// child is an orphan before anything ends the app. Each carries the user data folder in its argv, so
// the e2e counts it as a fixture process and ends it after a failed run.
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const udd = flag('user-data-dir') ?? ''
const asNode = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const KEEP = 'setInterval(() => {}, 1000)'
const directFile = flag('detached-child')
if (directFile) {
  const c = spawn(process.execPath, ['-e', KEEP, '--', `--fixture-of=${udd}`], { detached: true, stdio: 'ignore', env: asNode })
  writeFileSync(directFile, String(c.pid))
  c.unref()
}
const orphanFile = flag('detached-orphan')
if (orphanFile) {
  const middle =
    `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(KEEP)}, '--', process.argv[2]], { detached: true, stdio: 'ignore' }); ` +
    "require('node:fs').writeFileSync(process.argv[1], String(c.pid)); c.unref()"
  spawn(process.execPath, ['-e', middle, '--', orphanFile, `--fixture-of=${udd}`], { detached: true, stdio: 'ignore', env: asNode }).unref()
}

app.whenReady().then(() => {
  // paintWhenInitiallyHidden and no background throttling: said outright, so a window that is never
  // shown still paints and CDP's Page.captureScreenshot (screenshot() and every frame) does not stall.
  const w = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'Astera workspace fixture',
    show: !hidden,
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false }
  })
  // --maximize: what the Astera app does at start (src/main/index.ts), which on a hidden desktop
  // maximizes the window to the person's work area while the page keeps its first size (size.ts).
  if (process.argv.includes('--maximize')) w.maximize()
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
})
app.on('window-all-closed', () => app.quit())
