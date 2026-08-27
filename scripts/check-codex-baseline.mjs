// Re-checks the three upstream facts src/core/usage/codex.ts mirrors, against the latest codex release.
//
//   npm run check:codex-baseline
//
// Why this exists: the Context chip for codex sessions is computed the way the codex TUI computes
// `N% context left`, which means copying a constant (BASELINE_TOKENS = 12000) and a rounding rule out
// of codex's source. If codex changes either, our number drifts and **no data can tell us** — the
// rollout records raw token counts only, never the computed percentage, so there is nothing to
// calibrate against at runtime. A deliberate re-check is the only mechanism available.
//
// Not a vitest test on purpose: it needs the network, and the suite has to run offline.
//
// Exit 0 = all three facts still hold. Exit 1 = one of them changed (read the output, then decide what
// src/core/usage/codex.ts should do). Exit 2 = the check itself could not run (network, or the file
// moved upstream) — that is not a verdict about the constant.

const REPO = 'openai/codex'
const FILES = {
  tokenUsage: 'codex-rs/tui/src/token_usage.rs',
  statusControls: 'codex-rs/tui/src/chatwidget/status_controls.rs'
}

// What src/core/usage/codex.ts assumes. Each entry is a substring that must appear in the upstream
// file, verbatim. Substrings rather than a whole-file hash: the files carry plenty of unrelated code
// that changes often, and a hash would cry wolf on every release.
const EXPECTED = [
  {
    file: 'tokenUsage',
    what: 'BASELINE_TOKENS = 12000',
    needle: 'const BASELINE_TOKENS: i64 = 12000;'
  },
  {
    file: 'tokenUsage',
    what: '남은 비율 = (유효창 - 사용)/유효창, baseline 을 양쪽에서 뺀다',
    needle: 'let effective_window = context_window - BASELINE_TOKENS;'
  },
  {
    file: 'tokenUsage',
    what: '반올림은 remaining 쪽에서 한 번',
    needle: '.round() as i64'
  },
  {
    file: 'statusControls',
    what: '입력은 last_token_usage (total_token_usage 아님)',
    needle: '.map(|info| &info.last_token_usage)'
  },
  {
    file: 'statusControls',
    what: '표시값 = 100 - remaining',
    needle: '.map(|remaining| (100 - remaining).clamp(0, 100))'
  }
]

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'astera-baseline-check' }
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'astera-baseline-check' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.text()
}

/** The newest non-prerelease tag. The alpha channel moves constantly and is not what users install. */
async function latestTag() {
  const releases = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=30`)
  const stable = releases.find((r) => !r.prerelease && !r.draft)
  if (!stable) throw new Error('no stable release found')
  return stable.tag_name
}

async function main() {
  let tag, sources
  try {
    tag = await latestTag()
    sources = Object.fromEntries(
      await Promise.all(
        Object.entries(FILES).map(async ([key, p]) => [
          key,
          await getText(`https://raw.githubusercontent.com/${REPO}/${tag}/${p}`)
        ])
      )
    )
  } catch (err) {
    console.error(`검사를 수행할 수 없습니다: ${err.message}`)
    console.error('(네트워크 문제이거나 upstream 에서 파일이 옮겨진 경우입니다 — 상수에 대한 판정이 아닙니다)')
    process.exit(2)
  }

  console.log(`codex latest = ${tag}`)
  let failed = 0
  for (const { file, what, needle } of EXPECTED) {
    const ok = sources[file].includes(needle)
    if (!ok) failed++
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${what}`)
    if (!ok) console.log(`        찾지 못한 문자열: ${needle}\n        파일: ${FILES[file]}`)
  }

  if (failed === 0) {
    console.log('\nsrc/core/usage/codex.ts 의 전제가 그대로 유지됩니다.')
    return
  }
  console.log(
    `\n${failed}개가 어긋났습니다. src/core/usage/codex.ts 의 BASELINE_TOKENS·usedPercentOf 와` +
      `\n${FILES.tokenUsage} / ${FILES.statusControls} 를 대조하고, 주석의 확인 태그를 갱신하세요.`
  )
  process.exit(1)
}

await main()
