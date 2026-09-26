// The NSIS uninstaller removes the public shuttle (build/installer.nsh, customUnInstall). NSIS itself
// cannot run here, but the work is one PowerShell command, so this pulls that command out of the
// macro and runs it against a temp %LOCALAPPDATA%. The real one is never touched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { shuttleFiles } from './shuttle'

const nsh = readFileSync(path.join(__dirname, '..', '..', '..', '..', 'build', 'installer.nsh'), 'utf8')
const macro = /!macro customUnInstall\n([\s\S]*?)!macroend/.exec(nsh)?.[1] ?? ''

describe('installer.nsh customUnInstall', () => {
  // The old version's uninstaller also runs during an update. Removing the shuttle there would take
  // the command away from everyone who updates.
  it('does nothing during an update', () => {
    expect(macro).toMatch(/\$\{ifNot\} \$\{isUpdated\}/)
  })

  // %LOCALAPPDATA%\astera is shared. Only files, never a folder.
  it('never removes a folder', () => {
    expect(macro).not.toMatch(/RMDir/i)
    expect(macro).not.toMatch(/-Recurse/i)
  })
})

describe.runIf(process.platform === 'win32')('installer.nsh customUnInstall (PowerShell)', () => {
  let local: string
  let bin: string
  beforeEach(async () => {
    local = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-nsis-'))
    bin = path.join(local, 'astera', 'bin')
    await fs.mkdir(bin, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(local, { recursive: true, force: true })
  })

  const run = (): void => {
    const cmd = /-C "([^`]*)"`/.exec(macro)?.[1]
    expect(cmd, 'the PowerShell command in customUnInstall').toBeTruthy()
    // NSIS writes a literal `$` as `$$`.
    const ps = (cmd ?? '').replace(/\$\$/g, '$')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-C', ps], {
      env: { ...process.env, LOCALAPPDATA: local },
      stdio: 'ignore'
    })
  }

  it('removes the shuttle files Astera wrote and leaves the folder and its neighbours', async () => {
    for (const f of shuttleFiles({
      execPath: 'C:\\Program Files\\Astera\\Astera.exe',
      entryPath: 'C:\\Program Files\\Astera\\resources\\app.asar\\out\\main\\cli.js',
      platform: 'win32'
    }))
      await fs.writeFile(path.join(bin, f.name), f.content, 'utf8')
    await fs.writeFile(path.join(bin, 'other.cmd'), '@echo off\r\n', 'utf8')
    await fs.writeFile(path.join(local, 'astera', 'keep.json'), '{}', 'utf8')
    run()
    expect((await fs.readdir(bin)).sort()).toEqual(['other.cmd'])
    await expect(fs.readFile(path.join(local, 'astera', 'keep.json'), 'utf8')).resolves.toBe('{}')
  })

  it('leaves a file of the same name that Astera did not write', async () => {
    await fs.writeFile(path.join(bin, 'astera.cmd'), '@echo off\r\nnode C:\\tools\\astera.js %*\r\n', 'utf8')
    await fs.writeFile(path.join(bin, 'astera'), '#!/bin/sh\necho mine\n', 'utf8')
    run()
    expect((await fs.readdir(bin)).sort()).toEqual(['astera', 'astera.cmd'])
  })

  // The junction the .cmd reaches a non-ASCII install folder through (shuttle.ts, CmdLink). Removed as
  // a link only: the folder it points at, here still full, keeps every file.
  it('removes the app junction with the shuttle, as a link only, also when its target is gone', async () => {
    const target = path.join(local, '설치 폴더')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'Astera.exe'), 'x', 'utf8')
    const link = path.join(local, 'astera', 'app')
    await fs.symlink(target, link, 'junction')
    for (const f of shuttleFiles({
      execPath: path.join(target, 'Astera.exe'),
      entryPath: path.join(target, 'cli.js'),
      platform: 'win32',
      link: { link, root: target }
    }))
      await fs.writeFile(path.join(bin, f.name), f.content, 'utf8')
    run()
    await expect(fs.lstat(link)).rejects.toThrow()
    expect(await fs.readdir(target)).toEqual(['Astera.exe'])

    // The app's own uninstall may have removed the folder first: a dangling junction goes too.
    await fs.symlink(path.join(local, 'gone'), link, 'junction')
    run()
    await expect(fs.lstat(link)).rejects.toThrow()
  })

  it('leaves the app path alone when it is a real folder, or when a foreign astera.cmd stays', async () => {
    const app = path.join(local, 'astera', 'app')
    await fs.mkdir(app)
    await fs.writeFile(path.join(app, 'keep.txt'), 'k', 'utf8')
    run()
    expect(await fs.readdir(app)).toEqual(['keep.txt'])
    await fs.rm(app, { recursive: true })

    const target = path.join(local, 'target')
    await fs.mkdir(target)
    await fs.symlink(target, app, 'junction')
    await fs.writeFile(path.join(bin, 'astera.cmd'), '@echo off\r\nnode C:\\tools\\astera.js %*\r\n', 'utf8')
    run()
    expect((await fs.lstat(app)).isSymbolicLink()).toBe(true)
  })

  it('does not fail when the folder is not there', async () => {
    await fs.rm(path.join(local, 'astera'), { recursive: true, force: true })
    run()
    // PowerShell may leave its own Microsoft folder in %LOCALAPPDATA%; the point is that nothing
    // brings an astera folder back.
    expect(await fs.readdir(local)).not.toContain('astera')
  })
})
