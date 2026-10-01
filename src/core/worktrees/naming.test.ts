import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { absPath } from '../testPaths'
import {
  slugify, autoName, branchNameFor, candidateName, repoDirName, worktreePathFor, nameForTask,
  nameForRun, MAX_SUFFIX_ATTEMPTS, MAX_NAME_LENGTH
} from './naming'

describe('slugify', () => {
  it('공백·특수문자는 -로, 연속 -는 축약', () => {
    expect(slugify('login fix!!')).toBe('login-fix')
    expect(slugify('a  b//c')).toBe('a-b-c')
  })
  it('유니코드 문자(한글)는 유지', () => {
    expect(slugify('로그인 수정')).toBe('로그인-수정')
  })
  it('..은 .으로 축약, 앞뒤 .-는 트림', () => {
    expect(slugify('..a..b..')).toBe('a.b')
    expect(slugify('-x-')).toBe('x')
  })
  it('a trailing .lock, which git refuses in a ref, becomes -lock, and stays so when slugified again', () => {
    expect(slugify('Regenerate yarn.lock')).toBe('Regenerate-yarn-lock')
    expect(slugify('pin deps.LOCK')).toBe('pin-deps-LOCK')
    expect(slugify(slugify('Regenerate yarn.lock'))).toBe('Regenerate-yarn-lock')
    // only at the end: git refuses a component that ends with .lock
    expect(slugify('yarn.lock fix')).toBe('yarn.lock-fix')
  })
  it('유효 문자가 없으면 INVALID_NAME', () => {
    expect(() => slugify('!!!')).toThrow(/INVALID_NAME/)
    expect(() => slugify('   ')).toThrow(/INVALID_NAME/)
  })
})

describe('autoName', () => {
  it('random 주입 시 결정적이고 slug 규칙을 통과한다', () => {
    const a = autoName(() => 0)
    const b = autoName(() => 0.999)
    expect(a).not.toBe(b)
    expect(slugify(a)).toBe(a)
  })
})

describe('nameForTask', () => {
  it('제목이 slugify 가능하면 슬러그를 쓴다', () => {
    expect(nameForTask({ id: 'tsk_1', title: '로그인 수정' })).toBe('로그인-수정')
  })
  it('제목에 쓸 문자가 전혀 없으면(slugify가 던지면) Task id로 대체한다', () => {
    expect(nameForTask({ id: 'tsk_1', title: '!!!' })).toBe('tsk_1')
    expect(nameForTask({ id: 'tsk_1', title: '   ' })).toBe('tsk_1')
  })
})

describe('branchNameFor', () => {
  it('user.name을 slug화해 prefix로', () => {
    expect(branchNameFor('Park JP', 'login-fix')).toBe('Park-JP/login-fix')
  })
  it('user.name 없거나 slug 불가면 slug만', () => {
    expect(branchNameFor(null, 'login-fix')).toBe('login-fix')
    expect(branchNameFor('!!!', 'login-fix')).toBe('login-fix')
  })
})

describe('candidateName / MAX_SUFFIX_ATTEMPTS', () => {
  it('1회차는 그대로, n회차는 -n', () => {
    expect(candidateName('x', 1)).toBe('x')
    expect(candidateName('x', 2)).toBe('x-2')
  })
  it('상한은 20', () => expect(MAX_SUFFIX_ATTEMPTS).toBe(20))
})

describe('repoDirName / worktreePathFor', () => {
  it('.git 접미사 제거', () => {
    expect(repoDirName(absPath('repos', 'my-app.git'))).toBe('my-app')
  })
  it('루트/repo명/slug 조합', () => {
    const root = absPath('wt')
    expect(worktreePathFor(root, absPath('repos', 'my-app'), 'fix')).toBe(
      path.join(root, 'my-app', 'fix')
    )
  })
})

describe('nameForRun', () => {
  it('objective 를 슬러그로 만든다', () => {
    expect(nameForRun({ id: 'run_1', objective: '로그인 버그 고치기' })).toBe('로그인-버그-고치기')
  })

  it('쓸 글자가 없으면 id 로 물러난다', () => {
    expect(nameForRun({ id: 'run_abcd1234', objective: '///' })).toBe('run_abcd1234')
  })
})

describe('nameForRun / nameForTask, bounded length', () => {
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ').slice(0, 2000)

  it('a 2,000-character objective or title yields a name of at most 40 characters', () => {
    expect(long.length).toBe(2000)
    for (const name of [nameForRun({ id: 'run_1', objective: long }), nameForTask({ id: 'tsk_1', title: long })]) {
      expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH)
      expect(name.length).toBeGreaterThan(0)
      expect(slugify(name)).toBe(name)
    }
    expect(MAX_NAME_LENGTH).toBe(40)
  })

  it('cuts at the last - before the cap', () => {
    // 'word0-word1-...': the cap falls inside 'word6', so the cut goes back to the - before it
    expect(nameForRun({ id: 'run_1', objective: long })).toBe('word0-word1-word2-word3-word4-word5')
  })

  it('keeps a whole word that ends exactly at the cap', () => {
    const objective = `${'c'.repeat(34)} dddde ${'f'.repeat(20)}`
    expect(nameForRun({ id: 'run_1', objective })).toBe(`${'c'.repeat(34)}-dddde`)
  })

  it('trims a trailing . or - left by the cut', () => {
    const objective = `${'a'.repeat(38)}. ${'b'.repeat(50)}`
    expect(nameForRun({ id: 'run_1', objective })).toBe('a'.repeat(38))
  })

  it('cuts a single long word at the cap when it has no -', () => {
    expect(nameForTask({ id: 'tsk_1', title: 'x'.repeat(300) })).toBe('x'.repeat(40))
  })

  it('hard-cuts at the cap when the last - is in the first half', () => {
    const name = nameForRun({ id: 'run_1', objective: `a-${'z'.repeat(300)}` })
    expect(name).toBe(`a-${'z'.repeat(38)}`)
    expect(name.length).toBe(MAX_NAME_LENGTH)
  })

  it('a cut that lands on .lock does not leave a name git refuses', () => {
    // cut at the - after '.lock'
    expect(nameForRun({ id: 'run_1', objective: `${'b'.repeat(25)}.lock-${'c'.repeat(30)}` })).toBe(`${'b'.repeat(25)}-lock`)
    // hard cut that ends exactly on '.lock'
    expect(nameForTask({ id: 'tsk_1', title: `${'b'.repeat(35)}.lockccc` })).toBe(`${'b'.repeat(35)}-lock`)
  })

  it('leaves a short name as it was', () => {
    expect(nameForRun({ id: 'run_1', objective: 'Fix the login bug' })).toBe('Fix-the-login-bug')
  })
})
