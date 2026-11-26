// A JUnit XML report as one result (Phase 3 Part 2). Vitest, pytest, Gradle, Maven Surefire and others write this
// format. It is read by a forward-only scan of the subset a report uses (elements, attributes, text, CDATA, the five
// named and numeric references): no library, and no DTD is processed, so a report's entities expand to nothing.
import { TEST_BOUNDS, caseId, cutMessage, failurePlace, insideRun, uniqueIds, type ParsedReport, type TestCase, type TestStatus } from './types'

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** The five named references and numeric ones; any other `&name;` stays as written. */
function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, (whole, ref: string) => {
    if (ref[0] !== '#') return NAMED[ref]
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

/** Where a tag that starts at `from` ends (its `>`), skipping quoted attribute values; -1 when it never does. */
function tagEnd(xml: string, from: number): number {
  let quote: string | null = null
  for (let i = from; i < xml.length; i++) {
    const c = xml[i]
    if (quote !== null) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

/** Where a `<!DOCTYPE …>` (or another `<!…>`) that starts at `from` ends, past its internal subset in brackets. */
function declarationEnd(xml: string, from: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = from; i < xml.length; i++) {
    const c = xml[i]
    if (quote !== null) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === '>' && depth <= 0) return i
  }
  return -1
}

const SPACE = /\s/
const NAME_END = /[\s=/>]/

/** A tag's `name="value"` pairs, read in one pass whatever the tag holds (final review I2: a regex was quadratic on a
 *  long body without `=`). */
function attributes(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const n = body.length
  let i = 0
  while (i < n && !SPACE.test(body[i])) i++
  while (i < n) {
    const from = i
    while (i < n && SPACE.test(body[i])) i++
    const start = i
    while (i < n && !NAME_END.test(body[i])) i++
    const key = body.slice(start, i)
    while (i < n && SPACE.test(body[i])) i++
    if (key !== '' && body[i] === '=') {
      i++
      while (i < n && SPACE.test(body[i])) i++
      const quote = body[i]
      if (quote === '"' || quote === "'") {
        const close = body.indexOf(quote, i + 1)
        if (close < 0) break
        out[key] = decode(body.slice(i + 1, close))
        i = close + 1
      }
    }
    if (i === from) i++
  }
  return out
}

/** pytest's module file from a case's class (`tests.test_calc`, `tests.test_calc.TestCls`): the segments before the
 *  first in CapWords (a class), as a `.py` path. pytest writes them relative to its root, the run's folder. */
function pytestModuleFile(dotted: string): string | undefined {
  const segs = dotted.split('.')
  const firstClass = segs.findIndex((x) => /^[A-Z]/.test(x))
  const mod = firstClass < 0 ? segs : segs.slice(0, firstClass)
  if (mod.length === 0 || mod.some((x) => x === '' || /[\s/\\[\]]/.test(x))) return undefined
  return `${mod.join('/')}.py`
}

interface Open {
  name: string
  classname?: string
  file?: string
  line?: number
  time?: number
  status: TestStatus
  message?: string
  text: string
}

/** A report's cases, or null when the text is not a JUnit report (its first element is neither `testsuites` nor
 *  `testsuite`) or ends before its root closes (cut short while written: final review I4). `cwd` is the run's folder:
 *  files and places are made relative to it, and dropped outside it. A case's file comes from the report's own words for
 *  it (a `file` attribute, Vitest's class, pytest's module), never from where its failure was raised, so a case keeps
 *  its id whether it fails or passes (final review C3). */
export function parseJunit(xml: string, cwd: string): ParsedReport | null {
  let framework: ParsedReport['framework']
  let root: string | null = null
  const suites: string[] = []
  const cases: TestCase[] = []
  let truncated = false
  let open: Open | null = null
  let capturing = false
  let rootClosed = false

  const finish = (o: Open): void => {
    if (cases.length >= TEST_BOUNDS.cases) {
      truncated = true
      return
    }
    const fw = framework ?? 'junit'
    const failed = o.status === 'failed' || o.status === 'errored'
    const place = failed ? failurePlace(cwd, o.text) : undefined
    let suite: string[]
    let name = o.name
    let file = o.file !== undefined ? insideRun(cwd, o.file) : undefined
    let fileLevel = false
    if (fw === 'pytest' && (o.classname ?? '') === '') {
      // A module pytest could not collect: no class, and the module's dotted path as the name
      const mod = pytestModuleFile(o.name)
      file ??= mod !== undefined ? insideRun(cwd, mod) : undefined
      name = file ?? o.name
      suite = []
      fileLevel = failed
    } else if (fw === 'vitest') {
      // Vitest writes the describe blocks into the name and the file as the class
      const parts = o.name.split(' > ')
      name = parts[parts.length - 1]
      suite = parts.slice(0, -1)
      file ??= o.classname !== undefined ? insideRun(cwd, o.classname) : undefined
    } else {
      suite = o.classname !== undefined && o.classname !== '' ? [o.classname] : suites.length > 0 ? [suites[suites.length - 1]] : []
      // pytest's default family writes no file on a case: its class names the module
      if (fw === 'pytest' && o.classname !== undefined) {
        const mod = pytestModuleFile(o.classname)
        file ??= mod !== undefined ? insideRun(cwd, mod) : undefined
      }
    }
    // pytest counts a case's line from 0
    const caseLine = o.line !== undefined ? (fw === 'pytest' ? o.line + 1 : o.line) : undefined
    const at = place ?? (file !== undefined && caseLine !== undefined ? { file, line: caseLine } : undefined)
    const words = [o.message ?? '', o.text.trim()].filter((s) => s !== '').join('\n\n')
    cases.push({
      id: caseId(file, suite, name),
      ...(file !== undefined ? { file } : {}),
      suite,
      name,
      status: o.status,
      ...(o.time !== undefined ? { durationMs: Math.round(o.time * 1000) } : {}),
      ...(failed ? { failure: { message: cutMessage(words), ...(at ?? {}) } } : {}),
      ...(fileLevel ? { fileLevel: true as const } : {})
    })
  }

  let i = 0
  while (i < xml.length && !truncated) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) break
    if (capturing && open) open.text += decode(xml.slice(i, lt))
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      if (end < 0) break
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      if (end < 0) break
      if (capturing && open) open.text += xml.slice(lt + 9, end)
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      if (end < 0) break
      i = end + 2
      continue
    }
    if (xml.startsWith('<!', lt)) {
      const end = declarationEnd(xml, lt + 2)
      if (end < 0) break
      i = end + 1
      continue
    }
    const end = tagEnd(xml, lt + 1)
    if (end < 0) break
    const body = xml.slice(lt + 1, end)
    i = end + 1
    if (body.startsWith('/')) {
      const name = body.slice(1).trim()
      if (name === 'testsuite') {
        suites.pop()
        if (root === 'testsuite' && suites.length === 0) rootClosed = true
      } else if (name === 'testsuites' && root === 'testsuites') rootClosed = true
      if ((name === 'failure' || name === 'error') && open) capturing = false
      else if (name === 'testcase' && open) {
        finish(open)
        open = null
        capturing = false
      }
      continue
    }
    const selfClosing = body.endsWith('/')
    const name = /^[^\s/>]+/.exec(body)?.[0] ?? ''
    if (root === null) {
      if (name !== 'testsuites' && name !== 'testsuite') return null
      root = name
    }
    const attrs = attributes(selfClosing ? body.slice(0, -1) : body)
    if (name === 'testsuites' || (name === 'testsuite' && framework === undefined && root === 'testsuite')) {
      const said = attrs.name ?? ''
      if (/vitest/i.test(said)) framework = 'vitest'
      else if (/pytest/i.test(said)) framework = 'pytest'
    } else if (name === 'testsuite' && framework === undefined && attrs.name === 'pytest') framework = 'pytest' // a root without a name, pytest before 7
    if (name === 'testsuite' && selfClosing && root === 'testsuite' && suites.length === 0) rootClosed = true
    if (name === 'testsuite' && !selfClosing) suites.push(attrs.name ?? '')
    else if (name === 'testcase') {
      const time = attrs.time !== undefined ? Number.parseFloat(attrs.time) : NaN
      const line = attrs.line !== undefined ? Number.parseInt(attrs.line, 10) : NaN
      const o: Open = {
        name: attrs.name ?? '',
        ...(attrs.classname !== undefined ? { classname: attrs.classname } : {}),
        ...(attrs.file !== undefined ? { file: attrs.file } : {}),
        ...(Number.isFinite(line) ? { line } : {}),
        ...(Number.isFinite(time) ? { time } : {}),
        status: 'passed',
        text: ''
      }
      if (selfClosing) finish(o)
      else open = o
    } else if (open && (name === 'failure' || name === 'error')) {
      open.status = name === 'failure' ? 'failed' : 'errored'
      if (attrs.message !== undefined) open.message = attrs.message
      capturing = !selfClosing
    } else if (open && name === 'skipped' && open.status === 'passed') open.status = 'skipped'
  }
  if (root === null || (!rootClosed && !truncated)) return null
  return { framework: framework ?? 'junit', cases: uniqueIds(cases), ...(truncated ? { truncated: true as const } : {}) }
}
