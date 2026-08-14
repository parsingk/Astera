import { describe, it, expect } from 'vitest'
import { venvInterpreterPaths, pythonBinNames, parsePythonVersion, hasPythonProject } from './python'

describe('venvInterpreterPaths', () => {
  // venv 배치는 규약이지 표준이 아니고, 플랫폼마다 다르다
  it('win32 는 Scripts/python.exe', () => {
    expect(venvInterpreterPaths('D:\\p', 'win32')).toEqual([
      'D:\\p\\.venv\\Scripts\\python.exe',
      'D:\\p\\venv\\Scripts\\python.exe'
    ])
  })

  it('posix 는 bin/python', () => {
    expect(venvInterpreterPaths('/p', 'linux')).toEqual(['/p/.venv/bin/python', '/p/venv/bin/python'])
  })
})

describe('pythonBinNames', () => {
  it('win32 는 python, posix 는 python3 를 먼저 본다', () => {
    expect(pythonBinNames('win32')).toEqual(['python.exe', 'python3.exe'])
    expect(pythonBinNames('linux')).toEqual(['python3', 'python'])
  })
})

describe('parsePythonVersion', () => {
  // Python 3.4+ 는 --version 을 stdout 에 쓴다
  it('버전 토큰을 읽는다', () => {
    expect(parsePythonVersion('Python 3.11.4\n')).toBe('3.11.4')
  })

  // 구형 Python 2 는 stderr 에 썼다 — jdkScanner 의 verify() 처럼 호출자가 stdout+stderr 를 합쳐 넘긴다고 가정한다
  it('출력 어디에 있든 찾는다', () => {
    expect(parsePythonVersion('\nPython 2.7.18')).toBe('2.7.18')
  })

  it('버전 토큰이 없으면 null', () => {
    expect(parsePythonVersion('')).toBeNull()
    expect(parsePythonVersion('command not found')).toBeNull()
  })

  // Windows 의 Microsoft Store 별칭(WindowsApps\python.exe)이 스스로 뱉는 문구다. 종전 정규식은
  // 여기서 "was" 를 버전으로 읽었다 — 지금 그 별칭이 걸러지는 것은 execFile 이 그 reparse point 를
  // 아예 못 띄우기 때문이지 파서가 막아서가 아니었다
  it('Store 별칭의 "not found" 문구를 버전으로 읽지 않는다', () => {
    expect(
      parsePythonVersion('Python was not found; run without arguments to install from the Microsoft Store...')
    ).toBeNull()
  })
})

describe('hasPythonProject', () => {
  // RunTypePicker 의 "감지됨" 그룹으로 올릴지만 결정한다 — python/pytest 는 seed 구성이 없다
  // (package.json 의 스크립트 같은 단일 진입점이 없어서 seedKeyOf 로 무엇을 시드할지 정할 근거가 없다)
  it('pyproject.toml·requirements.txt·루트의 *.py 가 있으면 감지된 것으로 본다', () => {
    expect(hasPythonProject(['pyproject.toml'])).toBe(true)
    expect(hasPythonProject(['requirements.txt'])).toBe(true)
    expect(hasPythonProject(['main.py'])).toBe(true)
  })

  it('마커가 없으면 false', () => {
    expect(hasPythonProject(['package.json', 'README.md'])).toBe(false)
    expect(hasPythonProject([])).toBe(false)
  })
})
