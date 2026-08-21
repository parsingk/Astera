// Renders the README diagrams from assets/src/diagram.html and encodes them as GIFs.
//
// Run with Electron, which is already a dependency and carries Chromium — the page is real HTML/CSS,
// so nothing else can render it faithfully:
//
//   npx electron scripts/gen-diagram.js
//
// Needs `ffmpeg` on PATH for the encode. Writes one GIF per entry in DIAGRAMS into assets/.
//
// Why the pixel size is doubled: the README shows these at 820 CSS px. The first version was rendered
// at the page's own 900px, which is a shade over 1:1 on a 1x display and a 1.8x upscale on the HiDPI
// screens most laptops have — so the text arrived soft. At 2x a HiDPI viewer gets one image pixel per
// device pixel.
//
// The page is a six-state slideshow, not motion: setFrame(i) paints state i, and the durations below
// turn the six stills into the GIF's timeline.
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// The page's own size in CSS pixels — assets/src/diagram.html fixes the body to exactly this.
const PAGE_W = 900
const PAGE_H = 330
const SCALE = 2
const W = PAGE_W * SCALE
const H = PAGE_H * SCALE
// Seconds per state. The last one is held twice so the loop pauses on the outcome before restarting.
const DURATIONS = [2.4, 2.6, 2.6, 2.6, 2.4, 2.8]
const DIAGRAMS = [
  { set: 'rolling', out: 'rolling.gif' },
  { set: 'schedule', out: 'schedule.gif' },
  { set: 'jobs', out: 'jobs.gif' }
]

const repoRoot = path.join(__dirname, '..')
const source = path.join(repoRoot, 'assets', 'src', 'diagram.html')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Sizes the page so the paint buffer comes out W×H, whatever the machine's display is doing.
 *
 *  Offscreen rendering paints at the window's devicePixelRatio and ignores setZoomFactor, so the
 *  buffer is (CSS viewport × dpr). dpr cannot be relied on: it follows the monitor, and it was
 *  observed to differ *between two windows in the same process* (3 for the first, 1.5 for the
 *  second) — which quietly halved the second diagram's resolution. force-device-scale-factor does not
 *  settle it either.
 *
 *  So dpr is measured and cancelled out instead. A CSS zoom of SCALE/dpr makes the layout occupy
 *  PAGE_W × zoom viewport pixels, and that times dpr is PAGE_W × SCALE for any dpr at all. */
async function fitViewport(win) {
  const dpr = await win.webContents.executeJavaScript('devicePixelRatio')
  const zoom = SCALE / dpr
  // The window is sized in DIPs while the viewport is in CSS pixels, and the two are not the same
  // number. Measuring the ratio the window actually has beats assuming what it should be.
  const innerW = await win.webContents.executeJavaScript('innerWidth')
  const ratio = win.getContentSize()[0] / innerW
  await win.webContents.executeJavaScript(`document.documentElement.style.zoom=${zoom}`)
  win.setContentSize(Math.round(PAGE_W * zoom * ratio), Math.round(PAGE_H * zoom * ratio))
  await sleep(500) // the resize has to reach the compositor before the first state is captured
}

async function capture(win, set, dir, frames) {
  await win.loadFile(source, { search: `d=${set}` })
  await fitViewport(win)
  const count = await win.webContents.executeJavaScript('window.FRAME_COUNT')
  if (count !== DURATIONS.length)
    throw new Error(`frame count ${count} does not match the ${DURATIONS.length} durations`)

  const files = []
  for (let i = 0; i < count; i++) {
    frames.latest = null
    frames.count = 0
    await win.webContents.executeJavaScript(`window.setFrame(${i})`)
    // Wait for painting to *stop*, not merely to start. A state change produces several paints as the
    // compositor works through it, and taking the first one captures the diagram half-redrawn — which
    // showed up as the same six states encoding to a different file size on every run.
    const deadline = Date.now() + 10_000
    let seen = -1
    while (Date.now() < deadline) {
      if (frames.count === seen && frames.latest) break
      seen = frames.count
      await sleep(250)
    }
    if (!frames.latest) throw new Error(`no paint for ${set} frame ${i}`)
    // A viewport narrower than the page crops the diagram silently rather than failing, and an early
    // version of this script produced exactly that — frames that looked like a zoomed-in corner. The
    // rounding in fitViewport can leave a pixel either way, which the encode scales out.
    const { width, height } = frames.latest.getSize()
    if (Math.abs(width - W) > 2 || Math.abs(height - H) > 2)
      throw new Error(`frame is ${width}x${height}, expected about ${W}x${H} — cropped or mis-scaled`)
    const file = path.join(dir, `${set}-${i}.png`)
    fs.writeFileSync(file, frames.latest.toPNG())
    files.push(file)
  }
  return files
}

function encode(files, dir, outPath) {
  // ffmpeg's concat demuxer takes the per-frame durations. The last file is repeated because concat
  // ignores the duration of the final entry.
  const list = path.join(dir, 'list.txt')
  const posix = (p) => p.replace(/\\/g, '/')
  const lines = files.map((f, i) => `file '${posix(f)}'\nduration ${DURATIONS[i]}`)
  fs.writeFileSync(list, `${lines.join('\n')}\nfile '${posix(files.at(-1))}'\n`)

  // Two passes. A GIF holds 256 colours, and ffmpeg's default is a fixed palette that dithers flat
  // dark panels into noise — palettegen reads this diagram's own colours instead, which is what keeps
  // the text edges clean. The scale pins the output to exactly W×H, absorbing fitViewport's rounding.
  const size = `scale=${W}:${H}:flags=lanczos`
  const palette = path.join(dir, 'palette.png')
  const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' })
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `${size},palettegen=stats_mode=full`, palette])
  ff([
    '-f', 'concat', '-safe', '0', '-i', list, '-i', palette,
    // bayer at a small scale: the design is flat colour, so ordered dithering stays invisible where
    // error diffusion would crawl between frames and inflate the file
    '-lavfi', `[0:v]${size}[s];[s][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    outPath
  ])
}

app.disableHardwareAcceleration()

// Offscreen rendering, taking frames off the paint event. capturePage is the obvious call and it does
// not work here — it answers UnknownVizError for any window the compositor is not really presenting,
// which is every window this script would want (hidden, or parked off-screen).
function newWindow() {
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  const frames = { latest: null, count: 0 }
  win.webContents.on('paint', (_e, _dirty, image) => {
    frames.latest = image
    frames.count++
  })
  win.webContents.setFrameRate(10)
  return { win, frames }
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astera-diagram-'))
  try {
    // A window per diagram, all created up front. Reusing one window changed the scale on the second
    // load, and creating the second only after destroying the first made that load fail outright with
    // ERR_FAILED.
    const windows = DIAGRAMS.map(() => newWindow())
    for (const [i, d] of DIAGRAMS.entries()) {
      const { win, frames } = windows[i]
      const files = await capture(win, d.set, dir, frames)
      const out = path.join(repoRoot, 'assets', d.out)
      encode(files, dir, out)
      const kb = (fs.statSync(out).size / 1024).toFixed(0)
      console.log(`${d.out}: ${W}x${H}, ${files.length} states, ${kb} KB`)
    }
  } catch (err) {
    // Printed rather than left to become an unhandled rejection warning, which reports the stack and
    // swallows the message — the one thing that says what went wrong.
    console.error(`gen-diagram failed: ${err && err.message}`)
    fs.rmSync(dir, { recursive: true, force: true })
    return app.exit(1)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  app.exit(0)
})
