import { describe, it, expect, afterAll } from 'vitest'
import {
  addToUserPath,
  removeFromUserPath,
  runWindowsPowerShell,
  takeOffUserPathIfItBreaks,
  userPathStatus,
  type RunPowerShell
} from './userPath'

// The real registry and the real PowerShell, on a scratch key under HKCU\Software so the person's own
// Path is never touched: what the fake below stands in for, checked where it runs.
describe.skipIf(process.platform !== 'win32')('the scripts against the real registry (win32)', () => {
  const key = `Software\\AsteraUserPathTest-${process.pid}-${Date.now()}`
  // Each call starts a Windows PowerShell, and the write script also compiles its Add-Type and tells every
  // window. In the first seconds of a full run one such call was measured at 10 s, and one ran past the
  // 15 s default and was killed: the failure read "Command failed: ... #< CLIXML", which is what a killed
  // PowerShell leaves. That deadline is not what this checks, so each call here gets 45 s. With another
  // full run beside this one a write took up to 40 s and the test's nine calls 57 s together, hence 120 s
  // for the test.
  const run: RunPowerShell = (script) => runWindowsPowerShell(script, 45_000)
  afterAll(async () => {
    await run(`Remove-Item -LiteralPath 'HKCU:\\${key}' -Recurse -Force -ErrorAction SilentlyContinue`)
  })

  it('adds, keeps the kind and the variables unexpanded, and removes only its entry', async () => {
    const dirHere = 'C:\\Users\\me\\AppData\\Local\\astera\\bin'
    const envHere = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } as NodeJS.ProcessEnv
    // Ends in ';' on purpose: the real Path of the machine this was first run on did, and Uninstall has
    // to give that back to the character
    const original = '%USERPROFILE%\\bin;D:\\한글;'
    await run(
      `$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}'); $k.SetValue('Path', '${original}', [Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close()`
    )
    const read = async (): Promise<{ kind: string; value: string }> =>
      JSON.parse(
        await run(
          `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}'); [Console]::Out.Write((@{ kind = $k.GetValueKind('Path').ToString(); value = $k.GetValue('Path', $null, 'DoNotExpandEnvironmentNames') } | ConvertTo-Json -Compress))`
        )
      ) as { kind: string; value: string }
    expect(await addToUserPath({ dir: dirHere, env: envHere, key, run })).toBe('added')
    expect(await userPathStatus({ dir: dirHere, env: envHere, key, run })).toEqual({ has: true, fits: true })
    expect(await read()).toEqual({ kind: 'ExpandString', value: `${original}${dirHere};` })
    expect(await removeFromUserPath({ dir: dirHere, env: envHere, key, run })).toBe('removed')
    expect(await userPathStatus({ dir: dirHere, env: envHere, key, run })).toEqual({ has: false, fits: true })
    expect(await read()).toEqual({ kind: 'ExpandString', value: original })
  }, 120_000)
})

const dir = 'C:\\Users\\me\\AppData\\Local\\astera\\bin'
const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } as NodeJS.ProcessEnv

/** A registry the scripts read and write: the read script answers with it, a write script is decoded
 *  back from its base64 and its kind, the way PowerShell would run it. */
function fakeRegistry(
  start: { kind: 'String' | 'ExpandString' | 'None'; value: string },
  machine = 'C:\\WINDOWS\\system32;'
): {
  run: RunPowerShell
  now: { kind: string; value: string }
  writes: number
} {
  const state = { now: { ...start } as { kind: string; value: string }, writes: 0 }
  const run: RunPowerShell = async (script) => {
    const b64 = /FromBase64String\('([^']*)'\)/.exec(script)
    if (!b64) return JSON.stringify({ kind: state.now.kind, value: state.now.kind === 'None' ? null : state.now.value, machine })
    const kind = /RegistryValueKind\]::(\w+)/.exec(script)![1]
    state.now = { kind, value: Buffer.from(b64[1], 'base64').toString('utf8') }
    state.writes++
    return ''
  }
  return {
    run,
    get now() {
      return state.now
    },
    get writes() {
      return state.writes
    }
  }
}

describe('the win32 user Path the astera command is put on', () => {
  it('adds the folder, keeps the kind (an expanding Path stays expanding), and tells Explorer', async () => {
    const reg = fakeRegistry({ kind: 'ExpandString', value: '%USERPROFILE%\\bin;C:\\tools' })
    expect(await addToUserPath({ dir, env, run: reg.run })).toBe('added')
    expect(reg.now).toEqual({ kind: 'ExpandString', value: `%USERPROFILE%\\bin;C:\\tools;${dir}` })
    expect(await userPathStatus({ dir, env, run: reg.run })).toEqual({ has: true, fits: true })
  })

  it('writes nothing when the folder is there already', async () => {
    const reg = fakeRegistry({ kind: 'String', value: `C:\\tools;%LOCALAPPDATA%\\astera\\bin` })
    expect(await addToUserPath({ dir, env, run: reg.run })).toBe('present')
    expect(reg.writes).toBe(0)
  })

  it('makes a Path that does not exist yet, the kind Windows makes it', async () => {
    const reg = fakeRegistry({ kind: 'None', value: '' })
    expect(await addToUserPath({ dir, env, run: reg.run })).toBe('added')
    expect(reg.now).toEqual({ kind: 'ExpandString', value: dir })
  })

  it('takes out only the folder on Uninstall, keeping a plain Path plain', async () => {
    const reg = fakeRegistry({ kind: 'String', value: `C:\\tools;${dir};D:\\bin` })
    expect(await removeFromUserPath({ dir, env, run: reg.run })).toBe('removed')
    expect(reg.now).toEqual({ kind: 'String', value: 'C:\\tools;D:\\bin' })
    expect(await removeFromUserPath({ dir, env, run: reg.run })).toBe('absent')
    expect(reg.writes).toBe(1)
  })

  it('carries a value with quotes, semicolons and non-ASCII letters across unchanged', async () => {
    const odd = `C:\\'quoted' dir;D:\\한글 폴더`
    const reg = fakeRegistry({ kind: 'ExpandString', value: odd })
    await addToUserPath({ dir, env, run: reg.run })
    expect(reg.now.value).toBe(`${odd};${dir}`)
  })

  // Over the length Explorer passes on, Windows drops the whole user Path from new shells
  // (core/orchestration/cliInstall.ts userPathFits): adding the folder would take every other tool on it away.
  it('refuses to add the folder when the Path would grow past what new shells are given', async () => {
    const machine = `C:\\WINDOWS\\system32;${'m'.repeat(1608)};`
    const reg = fakeRegistry({ kind: 'String', value: 'u'.repeat(2465 - dir.length - 1) }, machine)
    expect(await addToUserPath({ dir, env, run: reg.run })).toBe('added')
    const full = fakeRegistry({ kind: 'String', value: 'u'.repeat(2465 - dir.length) }, machine)
    expect(await addToUserPath({ dir, env, run: full.run })).toBe('tooLong')
    expect(full.writes).toBe(0)
    // The refused Path itself still fits; the panel has to keep saying why, not offer the line to add it
    expect(await userPathStatus({ dir, env, run: full.run })).toEqual({ has: false, fits: false })
  })

  // 1.4.1 added the entry without the length check, so a Path just under the limit went over it and
  // every tool on it left new shells. At start the entry comes off again, but only when it is the cause.
  describe('takeOffUserPathIfItBreaks', () => {
    const machine = `C:\\WINDOWS\\system32;${'m'.repeat(1608)};`

    it('takes the folder off when it is what pushed the Path past the limit', async () => {
      const before = 'u'.repeat(2465 - dir.length)
      const reg = fakeRegistry({ kind: 'ExpandString', value: `${before};${dir}` }, machine)
      expect(await takeOffUserPathIfItBreaks({ dir, env, run: reg.run })).toBe('removed')
      expect(reg.now).toEqual({ kind: 'ExpandString', value: before })
    })

    it('leaves a Path alone that fits, that is too long without the folder too, or that lacks it', async () => {
      for (const value of [
        `${'u'.repeat(2465 - dir.length - 1)};${dir}`,
        `${'u'.repeat(2500)};${dir}`,
        'u'.repeat(2600)
      ]) {
        const reg = fakeRegistry({ kind: 'String', value }, machine)
        expect(await takeOffUserPathIfItBreaks({ dir, env, run: reg.run }), value.slice(-40)).toBe('kept')
        expect(reg.writes).toBe(0)
      }
    })
  })

  it('says when the folder is on the user Path but new shells are not given that Path', async () => {
    const machine = `C:\\WINDOWS\\system32;${'m'.repeat(1608)};`
    const reg = fakeRegistry({ kind: 'String', value: `${'u'.repeat(2500)};${dir}` }, machine)
    expect(await userPathStatus({ dir, env, run: reg.run })).toEqual({ has: true, fits: false })
  })
})
