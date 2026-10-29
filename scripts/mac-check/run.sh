#!/bin/bash
# The automatic part of the Mac check (scripts/mac-check/README.md, in Korean): the tests whose real-OS cases run only on
# macOS, a look at lsof and ps the way the Host's readers use them, and the scratch work folder the guided part
# (scripts/mac-check/checklist.md) runs its sessions in.
#
#   bash scripts/mac-check/run.sh
#
# What it may do: write inside this checkout (the build's out/, vitest's cache) and inside ~/astera-mac-check-<date>/,
# which holds every log, the summary, the copy of the checklist the person fills in, and the scratch work folder. The
# tests run with TMPDIR inside that folder, so their fixtures (and vitest's sweep of stale ones) stay there too.
# What it never does: sudo, the keychain, a dotfile, a model call. Claude Code and Codex are asked for `--version` and
# nothing else, as Astera itself asks before a sandboxed start (src/core/sessions/cliVersion.ts). The S2 measurement
# (scripts/measure) is not run: it writes fake credentials into the home folder and belongs on a CI runner.
#
# Written for macOS's /bin/bash 3.2: no associative arrays, no mapfile, no ${x,,}.
#
# ASTERA_MAC_CHECK_TEST_ONLY_NOT_A_MAC=1 is for trying this script's POSIX parts on Linux while it is developed: it lifts
# the macOS guard and skips the build and the tests, which need a Mac. A person never sets it.
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
not_a_mac=${ASTERA_MAC_CHECK_TEST_ONLY_NOT_A_MAC:-}

if [ "$(uname -s)" != Darwin ] && [ "$not_a_mac" != 1 ]; then
  echo "run.sh: 이 점검은 macOS 전용입니다 (이 컴퓨터: $(uname -s)). 아무것도 하지 않았습니다." >&2
  exit 2
fi

# The sandbox needs these, as the app checks them (ENFORCE_MIN, src/core/sessions/cliVersion.ts; guide.test.mjs keeps
# the two equal).
CLAUDE_MIN=2.1.306
CODEX_MIN=0.160.0

# A shell inside an Astera session carries that session's ASTERA_* variables; none of them may reach the tests.
for v in $(env | sed -n 's/^\(ASTERA_[A-Za-z0-9_]*\)=.*/\1/p' | grep -v '^ASTERA_MAC_CHECK_TEST_ONLY_'); do unset "$v"; done

R="$HOME/astera-mac-check-$(date +%Y-%m-%d)"
logs="$R/logs"
tmp="$R/tmp"
summary="$R/summary.txt"
mkdir -p "$logs" "$tmp" || { echo "run.sh: $R 를 만들 수 없습니다." >&2; exit 1; }
: > "$summary"
failures=0

say() { printf '%s\n' "$*"; printf '%s\n' "$*" >> "$summary"; }
section() { say ""; say "== $* =="; }
# One line per result: PASS, FAIL, SKIP or NOTE, then what was seen.
result() {
  say "$(printf '%-5s %-22s %s' "$1" "$2" "$3")"
  if [ "$1" = FAIL ]; then failures=$((failures + 1)); fi
}
now_ms() { node -e 'console.log(Date.now())'; }
# The first x.y.z in its input (`codex-cli 0.160.0`, `2.1.311 (Claude Code)`, `v22.20.0`), as parseCliVersion does.
version_of() { grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1; }
# Whether version $1 is $2 or later, part by part as numbers (atLeast, src/core/sessions/cliVersion.ts).
at_least() {
  local a b i x y
  IFS=. read -r -a a <<< "$1"
  IFS=. read -r -a b <<< "$2"
  for i in 0 1 2; do
    x=${a[$i]:-0}
    y=${b[$i]:-0}
    if [ "$x" -ne "$y" ]; then
      [ "$x" -gt "$y" ]
      return
    fi
  done
  return 0
}
# Runs a command for at most $1 seconds (macOS has no timeout(1)): its status, or 124 when it was cut off.
limited() {
  local secs=$1 pid waited=0
  shift
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge $((secs * 10)) ]; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  wait "$pid"
}
# Shell-quotes one word for a script this one writes.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# A path under the home folder as the person reads it, `~/.ssh`: a label, never a path to open.
home_label() { printf '%s/%s' '~' "$1"; }

say "Astera mac-check, $(date '+%Y-%m-%d %H:%M:%S')"
say "결과 폴더: $R"

# ---------------------------------------------------------------------------------------------------------------------
section "1. 준비물"
if [ "$not_a_mac" = 1 ]; then
  result NOTE system "$(uname -sr) $(uname -m) (시험용: macOS 가 아님)"
else
  result NOTE macOS "$(sw_vers -productVersion) $(uname -m)"
fi
if ! command -v git > /dev/null 2>&1; then
  result FAIL git "git 이 없습니다 (Xcode Command Line Tools: xcode-select --install)"
  exit 1
fi
result NOTE checkout "$root ($(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?') $(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo '?'))"
if [ -n "$(git -C "$root" status --porcelain 2>/dev/null)" ]; then
  result NOTE checkout "고친 파일이 있습니다 (git status 로 확인)"
fi

if ! command -v node > /dev/null 2>&1; then
  result FAIL node "node 가 없습니다. Node 22 를 설치하세요 (README 의 준비물)."
  exit 1
fi
node_min=$(node -e 'console.log(require(process.argv[1]).engines.node)' "$root/package.json" | version_of)
node_v=$(node -v | version_of)
if at_least "$node_v" "$node_min"; then
  if [ "${node_v%%.*}" = 22 ]; then result PASS node "$node_v ($node_min 이상, CI 와 같은 22)"
  else result PASS node "$node_v ($node_min 이상; CI 는 22 를 씁니다)"; fi
else
  result FAIL node "$node_v ($node_min 이상이 필요합니다)"
  exit 1
fi
result NOTE npm "$(npm -v 2>/dev/null)"

electron=""
if [ -x "$root/node_modules/.bin/vitest" ] && [ -f "$root/node_modules/electron/path.txt" ]; then
  electron="$root/node_modules/electron/dist/$(cat "$root/node_modules/electron/path.txt")"
fi
if [ -z "$electron" ] || [ ! -f "$electron" ]; then
  result FAIL "npm ci" "node_modules 가 없거나 Electron 이 빠졌습니다. 저장소 폴더에서 npm ci 를 먼저 하세요."
  exit 1
fi
result PASS "npm ci" "node_modules 와 Electron 이 있습니다"

for cli in claude codex; do
  if [ "$cli" = claude ]; then min=$CLAUDE_MIN; else min=$CODEX_MIN; fi
  found=$(command -v "$cli" 2>/dev/null)
  if [ -z "$found" ]; then
    result FAIL "$cli" "PATH 에 없습니다 ($min 이상이 필요합니다)"
    continue
  fi
  out=$(limited 30 "$cli" --version 2>&1)
  v=$(printf '%s\n' "$out" | version_of)
  if [ -z "$v" ]; then result FAIL "$cli" "버전을 읽지 못했습니다: $(printf '%s' "$out" | head -n 1)"
  elif at_least "$v" "$min"; then result PASS "$cli" "$v ($min 이상) $found"
  else result FAIL "$cli" "$v ($min 이상이 필요합니다) $found"; fi
done

# ---------------------------------------------------------------------------------------------------------------------
# Only whether each is there and whether it is a link: nothing is opened. Which ones are there decides what checks 2 and
# 8 compare; a link decides checks 7 and 11 (a link the session could change refuses a sandboxed start in the home).
section "2. 로그인 정보 폴더와 링크 (있는지만 봅니다. 열지 않습니다)"
for p in .ssh .aws .config/gh .config/gcloud .docker .kube .npmrc .git-credentials Library/Keychains; do
  f="$HOME/$p"
  if [ -L "$f" ]; then result NOTE "$(home_label "$p")" "링크 -> $(readlink "$f")"
  elif [ -e "$f" ]; then result NOTE "$(home_label "$p")" "있음"
  else result NOTE "$(home_label "$p")" "없음"; fi
done
links=""
for p in .config .cache .local Library "Library/Application Support"; do
  if [ -L "$HOME/$p" ]; then
    result NOTE "$(home_label "$p")" "링크 -> $(readlink "$HOME/$p")"
    links="$links $(home_label "$p")"
  fi
done
if [ -n "$links" ]; then result NOTE links "링크인 폴더:$links (점검 7 과 11 을 보세요)"
else result NOTE links "위 폴더 가운데 링크는 없습니다 (점검 11 은 건너뜁니다)"; fi

# ---------------------------------------------------------------------------------------------------------------------
# The two readers the Host runs on macOS: the Codex rollout owner (lsof, then ps for the parents;
# src/core/rolling/rolloutOwner.ts macOwnerReader) and the workspace tree kill (ps with pid, ppid and pgid under
# LC_ALL=C; src/host/workspace/posixProc.ts PS_TREE_ARGS). Each on a file or process of this script's own.
section "3. lsof 와 ps"
lsof_bin=/usr/sbin/lsof
if [ "$not_a_mac" = 1 ]; then lsof_bin=$(command -v lsof || echo /usr/sbin/lsof); fi
held="$tmp/lsof-held.txt"
free="$tmp/lsof-free.txt"
echo held > "$held"
echo free > "$free"
if [ ! -x "$lsof_bin" ]; then
  result FAIL lsof "$lsof_bin 이 없습니다"
else
  exec 3< "$held"
  t0=$(now_ms)
  holders=$(limited 20 "$lsof_bin" -w -t -- "$held")
  rc=$?
  t1=$(now_ms)
  exec 3<&-
  if [ "$rc" = 0 ] && printf '%s\n' "$holders" | grep -qx "$$"; then
    result PASS lsof-held "열어 둔 파일: 이 셸($$)을 찾았습니다, $((t1 - t0)) ms"
  else
    result FAIL lsof-held "열어 둔 파일: 종료 코드 $rc, 찾은 pid: $(printf '%s' "$holders" | tr '\n' ' ') (이 셸은 $$)"
  fi
  t0=$(now_ms)
  nobody=$(limited 20 "$lsof_bin" -w -t -- "$free" 2>&1)
  rc=$?
  t1=$(now_ms)
  if [ "$rc" = 1 ] && [ -z "$nobody" ]; then
    result PASS lsof-free "닫힌 파일: 아무도 열지 않았다고 답합니다 (종료 코드 1, 출력 없음), $((t1 - t0)) ms"
  else
    result FAIL lsof-free "닫힌 파일: 종료 코드 $rc, 출력: $(printf '%s' "$nobody" | head -n 2 | tr '\n' ' ')"
  fi
fi
t0=$(now_ms)
row=$(env LC_ALL=C ps -A -o pid= -o ppid= -o pgid= 2>/dev/null | awk -v me="$$" '$1 == me { print $1, $2, $3 }')
t1=$(now_ms)
if [ -n "$row" ]; then result PASS ps-tree "pid ppid pgid, 이 셸의 줄: $row, $((t1 - t0)) ms"
else result FAIL ps-tree "pid ppid pgid, 이 셸($$)의 줄이 없습니다"; fi
if /bin/ps -A -o pid=,ppid= 2>/dev/null | awk -v me="$$" '$1 == me { found = 1 } END { exit !found }'; then
  result PASS ps-parents "pid ppid, /bin/ps 가 이 셸을 보여 줍니다"
else
  result FAIL ps-parents "pid ppid, /bin/ps 에 이 셸이 없습니다"
fi

# ---------------------------------------------------------------------------------------------------------------------
# The same build `npm run build` does and CI runs, through the package's own binary so npm writes no log into ~/.npm.
section "4. 빌드"
if [ "$not_a_mac" = 1 ]; then
  result SKIP build "macOS 가 아님 (시험용 변수)"
else
  t0=$(now_ms)
  (cd "$root" && limited 900 ./node_modules/.bin/electron-vite build) > "$logs/build.log" 2>&1
  rc=$?
  t1=$(now_ms)
  if [ "$rc" = 0 ]; then result PASS build "$(((t1 - t0) / 1000)) 초, logs/build.log"
  else
    result FAIL build "종료 코드 $rc, logs/build.log"
    tail -n 30 "$logs/build.log" | sed 's/^/      /' | tee -a "$summary"
  fi
fi

# ---------------------------------------------------------------------------------------------------------------------
# One vitest run per group, each with its own log and JSON report. `strict`: every test in the group must run here, since
# a skipped one is a gate that did not open (the real-OS cases of these files run on macOS only).
section "5. 테스트"
vitest_group() {
  local id=$1 strict=$2 e2e=$3 counts total passed failed skipped rc t0 t1 status detail
  shift 3
  if [ "$not_a_mac" = 1 ]; then
    result SKIP "$id" "macOS 가 아님 (시험용 변수)"
    return
  fi
  local envs=("TMPDIR=$tmp/")
  if [ "$e2e" = 1 ]; then envs+=("ASTERA_DESKTOP_E2E=1"); fi
  t0=$(now_ms)
  (cd "$root" && limited 1200 env "${envs[@]}" ./node_modules/.bin/vitest run "$@" --reporter=default --reporter=json --outputFile.json="$logs/$id.json") > "$logs/$id.log" 2>&1
  rc=$?
  t1=$(now_ms)
  counts=$(node -e 'try { const r = require(process.argv[1]); console.log([r.numTotalTests, r.numPassedTests, r.numFailedTests, r.numPendingTests + (r.numTodoTests || 0)].join(" ")) } catch { console.log("") }' "$logs/$id.json")
  read -r total passed failed skipped <<EOF
$counts
EOF
  detail="통과 ${passed:-?} / 실패 ${failed:-?} / 건너뜀 ${skipped:-?} / 모두 ${total:-?}, $(((t1 - t0) / 1000)) 초, logs/$id.log"
  status=PASS
  if [ -z "$counts" ] || [ "$rc" != 0 ] || [ "${failed:-1}" != 0 ] || [ "${total:-0}" = 0 ]; then status=FAIL; fi
  if [ "$strict" = 1 ] && [ "${skipped:-1}" != 0 ]; then
    status=FAIL
    detail="$detail (macOS 에서 돌아야 할 테스트가 건너뛰어졌습니다)"
  fi
  result "$status" "$id" "$detail"
  if [ "$status" = FAIL ]; then tail -n 40 "$logs/$id.log" | sed 's/^/      /' | tee -a "$summary"; fi
}
# The POSIX tree kill (workspace tree kill, Task A): the real killPosixTree and spawnDetached cases.
vitest_group posix-tree-kill 1 0 src/host/workspace/posixProc.test.ts src/host/workspace/posixProc.treeTimeout.test.ts
# The macOS desk: real launches, a child started detached, a real app bundle opened in the background.
vitest_group mac-desk 1 0 src/host/workspace/deskMac.test.ts src/host/workspace/deskMac.psTimeout.test.ts
# The agent app workspace end to end in this logged-in session (CI's macOS step, gated by ASTERA_DESKTOP_E2E=1).
vitest_group mac-desk-e2e 1 1 src/host/workspace/desktop.mac.e2e.test.ts
# The manual update's unzip with the real ditto and xattr.
vitest_group manual-install 1 0 src/main/manualInstall.test.ts
# The Codex rollout owner (Task D and G): the macOS reader's cases, and the locate that asks it.
vitest_group rollout-owner 0 0 src/core/rolling/rolloutOwner.test.ts src/core/rolling/codexLocate.test.ts
# The sandbox builders (Task E): the lists, the start warnings and the link rule against this Mac's real folders.
vitest_group sandbox-builders 0 0 src/core/sandbox src/core/sessions/statusline.test.ts src/host/spawner.test.ts

# ---------------------------------------------------------------------------------------------------------------------
# The guided part's scratch work folder (checklist.md, 준비): a git repository with one commit and a linked worktree of
# it, plus the workspace fixture's launcher for check 9. Kept as it is when it is already there, since sessions may be
# using it.
section "6. 안내 점검에 쓸 작업 폴더"
work="$R/work"
repo="$work/mac-check-repo"
wt="$work/mac-check-repo-wt"
if [ -d "$repo/.git" ]; then
  result NOTE work "이미 있어 그대로 둡니다: $repo"
else
  mkdir -p "$repo/mac-check-app"
  printf '%s\n' '# mac-check scratch repository' '' 'Made by scripts/mac-check/run.sh for the guided Mac check. Safe to delete.' > "$repo/README.md"
  printf '%s\n' 'node_modules/' > "$repo/.gitignore"
  # The workspace fixture (src/host/workspace/fixtures/app/main.cjs) with a child it starts detached, as Astera's dev
  # app starts its Host. Its user data folder and the child's pid file sit beside the repository, not in it.
  {
    echo '#!/bin/sh'
    echo '# Check 9: the workspace fixture of the Astera checkout, with a child it starts detached. Written by run.sh.'
    echo "exec $(sq "$electron") $(sq "$root/src/host/workspace/fixtures/app/main.cjs") --remote-debugging-port=\"\$ASTERA_APP_CDP_PORT\" --user-data-dir=$(sq "$work/fixture-profile") --detached-child=$(sq "$work/fixture-child.pid") \$ASTERA_APP_CHROMIUM_FLAGS"
  } > "$repo/mac-check-app/start.sh"
  chmod +x "$repo/mac-check-app/start.sh"
  printf '%s\n' '// Check 9: launch the fixture the way the astera-app skill does.' "log(await launch({ command: './mac-check-app/start.sh' }))" 'log((await snapshot()).title)' > "$repo/mac-check-app/launch.js"
  printf '%s\n' '// Check 9: end the fixture and everything it started.' 'await close()' "log('closed')" > "$repo/mac-check-app/close.js"
  if git -C "$repo" init -q \
    && git -C "$repo" symbolic-ref HEAD refs/heads/main \
    && git -C "$repo" config user.name 'Astera mac-check' \
    && git -C "$repo" config user.email 'mac-check@example.invalid' \
    && git -C "$repo" config commit.gpgsign false \
    && git -C "$repo" add -A \
    && git -C "$repo" commit -q -m 'mac-check: start' \
    && git -C "$repo" worktree add -q -b mac-check-wt "$wt"; then
    result PASS work "저장소 $repo, worktree $wt"
  else
    result FAIL work "작업 폴더를 만들지 못했습니다: $repo"
  fi
fi

# ---------------------------------------------------------------------------------------------------------------------
section "7. 다음"
if [ "$failures" = 0 ]; then result PASS total "실패 없음"
else result FAIL total "실패 $failures 개 (위의 FAIL 줄)"; fi
say "다음: $R/checklist.md 를 열어 '준비' 부터 차례로 하세요."

# The person fills in the copy; a second run puts its new summary into the same copy and keeps their answers.
if [ ! -f "$R/checklist.md" ]; then cp "$here/checklist.md" "$R/checklist.md"; fi
awk -v f="$summary" '
  /<!-- run.sh summary start -->/ { print; print "```text"; while ((getline l < f) > 0) print l; print "```"; skip = 1; next }
  /<!-- run.sh summary end -->/ { skip = 0 }
  !skip { print }
' "$R/checklist.md" > "$R/checklist.md.new" && mv "$R/checklist.md.new" "$R/checklist.md"

rm -rf "$tmp"
if [ "$failures" = 0 ]; then exit 0; else exit 1; fi
