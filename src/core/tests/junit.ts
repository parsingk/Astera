// A JUnit XML report as one result (Phase 3 Part 2). Vitest, pytest, Gradle, Maven Surefire and others write this
// format. It is read by a forward-only scan of the subset a report uses (elements, attributes, text, CDATA, the five
// named and numeric references): no library, and no DTD is processed, so a report's entities expand to nothing.
import { TEST_BOUNDS, caseId, cutMessage, failurePlace, insideRun, type ParsedReport, type TestCase, type TestStatus } from './types'

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

function attributes(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let m = re.exec(body); m !== null; m = re.exec(body)) out[m[1]] = decode(m[2] ?? m[3] ?? '')
  return out
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
 *  `testsuite`). `cwd` is the run's folder: files and places are made relative to it, and dropped outside it. */
export function parseJunit(xml: string, cwd: string): ParsedReport | null {
  let framework: ParsedReport['framework']
  let root: string | null = null
  const suites: string[] = []
  const cases: TestCase[] = []
  let truncated = false
  let open: Open | null = null
  let capturing = false

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
    if (fw === 'vitest') {
      // Vitest writes the describe blocks into the name and the file as the class
      const parts = o.name.split(' > ')
      name = parts[parts.length - 1]
      suite = parts.slice(0, -1)
      file ??= o.classname !== undefined ? insideRun(cwd, o.classname) : undefined
    } else {
      suite = o.classname !== undefined && o.classname !== '' ? [o.classname] : suites.length > 0 ? [suites[suites.length - 1]] : []
    }
    // pytest's default family writes no file on a case; its failure names it
    file ??= place?.file
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
      ...(failed ? { failure: { message: cutMessage(words), ...(at ?? {}) } } : {})
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
      if (name === 'testsuite') suites.pop()
      else if ((name === 'failure' || name === 'error') && open) capturing = false
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
    }
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
  if (root === null) return null
  return { framework: framework ?? 'junit', cases, ...(truncated ? { truncated: true as const } : {}) }
}
