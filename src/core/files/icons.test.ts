import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ICON_IDS, resolveFileIcon, resolveFolderIcon, listMappedSpecs } from './icons'
import type { IconTone } from './icons'

describe('resolveFileIcon — 확장자', () => {
  it('언어 확장자는 label 모양 + 라벨 문자', () => {
    expect(resolveFileIcon('App.tsx')).toEqual({ id: 'label', tone: 'cyan', label: 'TS' })
    expect(resolveFileIcon('index.ts')).toEqual({ id: 'label', tone: 'blue', label: 'TS' })
    expect(resolveFileIcon('main.js')).toEqual({ id: 'label', tone: 'yellow', label: 'JS' })
    expect(resolveFileIcon('serve.py')).toEqual({ id: 'label', tone: 'green', label: 'PY' })
    expect(resolveFileIcon('report.pdf')).toEqual({ id: 'label', tone: 'red', label: 'PDF' })
  })

  it('기호 글리프 계열', () => {
    expect(resolveFileIcon('data.json')).toEqual({ id: 'code-braces', tone: 'yellow' })
    expect(resolveFileIcon('styles.css')).toEqual({ id: 'code-hash', tone: 'cyan' })
    expect(resolveFileIcon('theme.scss')).toEqual({ id: 'code-hash', tone: 'pink' })
    expect(resolveFileIcon('index.html')).toEqual({ id: 'code-angle', tone: 'orange' })
    expect(resolveFileIcon('README.md')).toEqual({ id: 'markdown', tone: 'cyan' })
    expect(resolveFileIcon('notes.txt')).toEqual({ id: 'text-lines', tone: 'gray' })
    expect(resolveFileIcon('ci.yml')).toEqual({ id: 'gear', tone: 'purple' })
  })

  it('전용 실루엣 계열', () => {
    expect(resolveFileIcon('logo.png')).toEqual({ id: 'image', tone: 'purple' })
    expect(resolveFileIcon('icon.svg')).toEqual({ id: 'image', tone: 'purple' })
    expect(resolveFileIcon('clip.mp4')).toEqual({ id: 'video', tone: 'pink' })
    expect(resolveFileIcon('beep.mp3')).toEqual({ id: 'audio', tone: 'pink' })
    expect(resolveFileIcon('src.zip')).toEqual({ id: 'archive', tone: 'orange' })
    expect(resolveFileIcon('dump.sql')).toEqual({ id: 'database', tone: 'orange' })
    expect(resolveFileIcon('setup.ps1')).toEqual({ id: 'terminal', tone: 'green' })
    expect(resolveFileIcon('rows.csv')).toEqual({ id: 'table', tone: 'green' })
    expect(resolveFileIcon('deps.lock')).toEqual({ id: 'lock', tone: 'gray' })
  })

  it('대소문자를 무시한다', () => {
    expect(resolveFileIcon('APP.TSX')).toEqual({ id: 'label', tone: 'cyan', label: 'TS' })
    expect(resolveFileIcon('Logo.PNG')).toEqual({ id: 'image', tone: 'purple' })
  })

  it('미등록·확장자 없음·빈 문자열은 기본 아이콘', () => {
    expect(resolveFileIcon('mystery.qqq')).toEqual({ id: 'file', tone: 'gray' })
    expect(resolveFileIcon('CHANGELOG')).toEqual({ id: 'file', tone: 'gray' })
    expect(resolveFileIcon('')).toEqual({ id: 'file', tone: 'gray' })
  })

  it('선두 점은 확장자로 취급하지 않는다', () => {
    expect(resolveFileIcon('.unknownrc')).toEqual({ id: 'file', tone: 'gray' })
  })
})

describe('매핑 완전성', () => {
  it('모든 spec의 id가 ICON_IDS에 있고 라벨은 3자 이하, label은 id가 label일 때만', () => {
    for (const spec of listMappedSpecs()) {
      expect(ICON_IDS).toContain(spec.id)
      if (spec.label) {
        expect(spec.label.length).toBeLessThanOrEqual(3)
        // FileIcon은 id === 'label'일 때만 glyph(label)을 그린다 — 다른 id에 label을
        // 붙이면 typecheck·런타임 모두 통과하지만 화면에는 조용히 안 나온다.
        expect(spec.id).toBe('label')
      }
    }
  })
})

describe('IconTone ↔ CSS', () => {
  // IconTone은 타입이라 런타임에 열거할 수 없다 — 여기서 직접 나열하고 readonly IconTone[]에
  // 대입해 IconTone과 어긋나면(추가/삭제) typecheck가 잡게 한다. length 단언은 새 톤 추가 시
  // 이 목록도 함께 갱신하도록 강제한다.
  const TONES: readonly IconTone[] = [
    'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'gray', 'mute'
  ] as const

  it('톤 목록은 정확히 10종', () => {
    expect(TONES.length).toBe(10)
  })

  it('모든 톤에 .fi--<tone> 규칙과 --fi-<tone> 커스텀 프로퍼티가 styles.css에 있다', () => {
    const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../renderer/src/styles.css')
    const css = readFileSync(cssPath, 'utf8')
    for (const tone of TONES) {
      expect(css).toMatch(new RegExp(`\\.fi--${tone}\\s*\\{[^}]*color:\\s*var\\(--fi-${tone}\\)`))
      expect(css).toMatch(new RegExp(`--fi-${tone}\\s*:`))
    }
  })
})

describe('resolveFileIcon — 우선순위', () => {
  it('정확한 이름이 확장자보다 우선', () => {
    expect(resolveFileIcon('package.json')).toEqual({ id: 'code-braces', tone: 'red' })
    expect(resolveFileIcon('package-lock.json')).toEqual({ id: 'lock', tone: 'gray' })
    expect(resolveFileIcon('go.sum')).toEqual({ id: 'lock', tone: 'gray' })
    expect(resolveFileIcon('go.mod')).toEqual({ id: 'label', tone: 'cyan', label: 'GO' })
    expect(resolveFileIcon('.gitignore')).toEqual({ id: 'git', tone: 'orange' })
    expect(resolveFileIcon('Makefile')).toEqual({ id: 'terminal', tone: 'orange' })
    expect(resolveFileIcon('LICENSE')).toEqual({ id: 'text-lines', tone: 'yellow' })
    expect(resolveFileIcon('.eslintrc')).toEqual({ id: 'gear', tone: 'gray' })
    expect(resolveFileIcon('docker-compose.yml')).toEqual({ id: 'container', tone: 'blue' })
  })

  it('접두 일치', () => {
    expect(resolveFileIcon('tsconfig.json')).toEqual({ id: 'code-braces', tone: 'blue' })
    expect(resolveFileIcon('tsconfig.web.json')).toEqual({ id: 'code-braces', tone: 'blue' })
    expect(resolveFileIcon('.env')).toEqual({ id: 'gear', tone: 'yellow' })
    expect(resolveFileIcon('.env.local')).toEqual({ id: 'gear', tone: 'yellow' })
    expect(resolveFileIcon('Dockerfile.dev')).toEqual({ id: 'container', tone: 'blue' })
  })

  it('tsconfig 접두는 .json 확장자일 때만', () => {
    expect(resolveFileIcon('tsconfignotes.txt')).toEqual({ id: 'text-lines', tone: 'gray' })
  })

  it('접두는 뒤가 이름 끝이거나 점일 때만 매칭한다', () => {
    // 접두를 글자 그대로만 보면 .envrc·dockerfile-notes.md까지 끌려온다
    expect(resolveFileIcon('.envrc')).toEqual({ id: 'file', tone: 'gray' })
    expect(resolveFileIcon('dockerfile-notes.md')).toEqual({ id: 'markdown', tone: 'cyan' })
    expect(resolveFileIcon('tsconfignotes.json')).toEqual({ id: 'code-braces', tone: 'yellow' })
  })

  it('프로토타입 상속 키를 파일명으로 써도 기본 아이콘으로 떨어진다', () => {
    // plain object 조회는 constructor·__proto__에서 상속값을 물어온다 (소문자화 때문에
    // toString·valueOf 등은 애초에 도달하지 않는다)
    expect(resolveFileIcon('constructor')).toEqual({ id: 'file', tone: 'gray' })
    expect(resolveFileIcon('__proto__')).toEqual({ id: 'file', tone: 'gray' })
    expect(resolveFileIcon('x.constructor')).toEqual({ id: 'file', tone: 'gray' })
  })

  it('복합 확장자', () => {
    expect(resolveFileIcon('types.d.ts')).toEqual({ id: 'label', tone: 'purple', label: 'TS' })
    expect(resolveFileIcon('bundle.tar.gz')).toEqual({ id: 'archive', tone: 'orange' })
    expect(resolveFileIcon('backup.tar.bz2')).toEqual({ id: 'archive', tone: 'orange' })
  })

  it('테스트 파일은 언어 아이콘 + badge', () => {
    expect(resolveFileIcon('tree.test.ts')).toEqual({ id: 'label', tone: 'blue', label: 'TS', badge: 'test' })
    expect(resolveFileIcon('view.spec.tsx')).toEqual({ id: 'label', tone: 'cyan', label: 'TS', badge: 'test' })
    expect(resolveFileIcon('thing.test.qqq')).toEqual({ id: 'file', tone: 'gray', badge: 'test' })
  })

  it('badge를 붙여도 원본 테이블은 오염되지 않는다', () => {
    resolveFileIcon('tree.test.ts')
    expect(resolveFileIcon('index.ts')).toEqual({ id: 'label', tone: 'blue', label: 'TS' })
  })
})

describe('resolveFolderIcon', () => {
  it('프로토타입 상속 키를 폴더명으로 써도 tone은 gray', () => {
    expect(resolveFolderIcon('constructor', false)).toEqual({ id: 'folder', tone: 'gray' })
    expect(resolveFolderIcon('__proto__', true)).toEqual({ id: 'folder-open', tone: 'gray' })
  })

  it('펼침 여부로 모양이 갈린다', () => {
    expect(resolveFolderIcon('anything', false).id).toBe('folder')
    expect(resolveFolderIcon('anything', true).id).toBe('folder-open')
  })

  it('특수 폴더는 색으로 구분한다', () => {
    expect(resolveFolderIcon('src', false).tone).toBe('blue')
    expect(resolveFolderIcon('lib', false).tone).toBe('blue')
    expect(resolveFolderIcon('__tests__', false).tone).toBe('green')
    expect(resolveFolderIcon('docs', false).tone).toBe('cyan')
    expect(resolveFolderIcon('assets', false).tone).toBe('purple')
    expect(resolveFolderIcon('config', false).tone).toBe('pink')
    expect(resolveFolderIcon('scripts', false).tone).toBe('yellow')
    expect(resolveFolderIcon('.github', false).tone).toBe('orange')
  })

  it('의존성·생성물·캐시는 mute로 낮춘다', () => {
    expect(resolveFolderIcon('node_modules', false).tone).toBe('mute')
    expect(resolveFolderIcon('dist', false).tone).toBe('mute')
    expect(resolveFolderIcon('.venv', false).tone).toBe('mute')
    expect(resolveFolderIcon('__pycache__', false).tone).toBe('mute')
    expect(resolveFolderIcon('.turbo', false).tone).toBe('mute')
  })

  it('그 외는 무채색이고 대소문자를 무시한다', () => {
    expect(resolveFolderIcon('components', false).tone).toBe('gray')
    expect(resolveFolderIcon('SRC', true)).toEqual({ id: 'folder-open', tone: 'blue' })
  })
})
