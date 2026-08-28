// UI 아이콘으로 쓰인 유니코드 기호가 몇 곳 남았는지 센다. 기호 목록을 손으로 적으면 반드시 빠지므로
// (이 작업의 첫 스캔이 이모지와 화살표 15곳을 놓쳤다) \p{S} 카테고리와 이모지 범위로 훑는다.
// 글에 쓰인 화살표(' → ' 로 계정 사슬을 잇는 자리)까지 걸리므로, 결과는 사람이 한 번 걸러 읽는다.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/renderer/src'

function isSymbol(ch) {
  const o = ch.codePointAt(0)
  // ASCII 와 라틴 보충 구역의 기호(<, >, =, +, ©)는 코드에 널려 있어 세지 않는다
  if (o < 0x2000) return false
  // 한글·CJK·전각 문장부호는 본문이다
  if ((o >= 0x3000 && o <= 0x303f) || (o >= 0x4e00 && o <= 0x9fff)) return false
  if ((o >= 0x1100 && o <= 0x11ff) || (o >= 0x3130 && o <= 0x318f) || (o >= 0xac00 && o <= 0xd7af)) return false
  return /\p{S}/u.test(ch) || (o >= 0x1f300 && o <= 0x1faff)
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []
  })
}

const hits = []
for (const file of walk(ROOT)) {
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const t = line.trim()
      // 주석 줄은 세지 않는다 — 이 기호들은 주석에서 "✕ 는 무엇을 닫는다" 처럼 자주 언급된다
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      const code = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/.*$/, '')
      for (const ch of code) {
        if (isSymbol(ch)) hits.push({ ch, file: file.replace(/\\/g, '/'), line: i + 1 })
      }
    })
}

const counts = new Map()
for (const h of hits) counts.set(h.ch, (counts.get(h.ch) ?? 0) + 1)
console.log(`기호 ${hits.length}건`)
for (const [ch, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ch} U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} : ${n}`)
}
const seen = new Set()
for (const h of hits) {
  const key = `${h.ch}${h.file}${h.line}`
  if (seen.has(key)) continue
  seen.add(key)
  console.log(`[${h.ch}] ${h.file}:${h.line}`)
}
