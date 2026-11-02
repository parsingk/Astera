# Astera macOS 점검 결과 (2026-11-02, 2회차)

`scripts/mac-check/checklist.md` 를 채운 결과입니다. 1회차(`docs/2026-10-29-mac-check-results.md`)에서 고친 것이 들어간
develop `8ad27fd9` 로, 사람 대신 Claude Code 에이전트가 이 Mac 에서 `run.sh` 를 돌리고 손 점검을 직접 했습니다.

- 환경: macOS 26.3.1 (arm64), Node 24.16.0, Codex 0.165.0. Claude Code 는 `run.sh` 때 2.1.314 였고 손 점검 도중 스스로
  2.1.316 으로 올랐습니다.
- 점검표, `run.sh` 요약, 손 점검 모두 develop `8ad27fd9` 의 빌드입니다. 아래 "점검하며 찾아 고친 것" 은 점검을 마친 뒤에
  고쳤고, 각 점검의 메모에 **이후** 로 적었습니다.
- 사람이 하는 것과 다르게 한 것은 1회차와 같습니다.
  - 개발용 앱과 점검 25 의 패키지한 앱은 에이전트 앱 작업 공간에서 띄우고 inspector 로 바로 숨겼습니다. 숨긴 창이 한 번도
    그려지지 않으면 스크린샷이 시간 초과로 끝나서, 그때는 페이지의 글(snapshot, DOM)로 읽었습니다.
  - 폴더 고르는 창은 main 프로세스에서 `dialog.showOpenDialog` 를 바꿔치기해 경로를 넘겼습니다.
  - 세션에 붙여 넣는 글은 개발용 Host 의 `astera sessions send` 로 bracketed paste 로 보냈고, 출력은 `sessions read` 와
    대화 기록 파일에서 읽었습니다.
  - 앱은 Cmd+Q 대신 페이지의 `window.api.app.quit()` 로 껐습니다.
- 하지 않은 점검: 20, 21, 23 은 사람만 하는 점검입니다. 11 과 13b 는 해당 없음입니다.
- 홈 폴더 경로는 `~` 로, 계정 폴더 이름은 `<계정>` 으로, 긴 id 와 JSON 은 `…` 로 줄였습니다. 페어링 문자열과 `code`,
  토큰 값은 옮기지 않았습니다.
- 결과: 실패 3개(12, 18, 25), 나머지는 통과. 실패한 셋과 따로 볼 것은 모두 원인을 찾았습니다.
- 점검하며 찾아 고친 것:
  - `711020bf` 점검 12b: sandbox Codex 가 공유한 MCP 도구를 부르지 못하던 것
    (`MCP tool call requires approval, but approval policy is never`)
  - `4c859a1f` 점검 18, 25: sandbox 안 Claude 워커의 보고(`--body -` 를 파이프나 heredoc 으로)가 sandbox 안에서 돌아 Host 에
    닿지 못하고, CLI 가 `host start` 를 권해 워커가 환경 변수를 뒤지던 것
  - `b2d49fab` 점검 4: 열린 Run 상세가 마지막 상태 변화 뒤에 쓴 토큰을 보여 주지 않던 것
  - `4c9998c8` 점검 29: 에이전트 세션의 보고서 거절에 이미 전체 제어인 페어링을 다시 하라는 다음 단계가 붙던 것
  - `bd48bfe6` 점검 27: 점검표의 두 기대가 실제와 다르던 것
  - `07687fec` git 이 한국어로 답하는 Mac 에서 예제 플러그인 테스트 하나가 실패하던 것
- 고치지 않은 것: 점검 14 는 앱 문제가 아니라 에이전트가 설정 창을 닫지 못한 것이었습니다. 계정 자체의 `config.toml` 에 있는
  Codex MCP 서버는 sandbox 에서 여전히 승인을 요구합니다. 재현에 쓴 작업을 지운 뒤에도 그 Run 의 코디네이터 세션이 살아
  있었습니다.

채우는 법:

- 통과하면 `- [ ] 통과` 를 `- [x] 통과` 로 바꿉니다. 실패하면 `- [x] 실패` 로 바꾸고, `메모` 에 무엇이 달랐는지 적습니다.
- '출력' 칸에는 세션이나 터미널이 보여 준 것을 그대로 붙여 넣습니다. 길면 앞뒤 몇 줄만 남겨도 됩니다.
- 비밀번호, 토큰, 키의 내용은 어디에도 붙여 넣지 마세요. 아래 명령은 그런 값을 출력하지 않습니다.
- `Operation not permitted` 는 셸에 따라 `operation not permitted` 처럼 소문자로도 나옵니다. 같은 뜻입니다.
- 점검 하나가 막혀 더 나갈 수 없으면, 본 것을 메모에 적고 다음 점검으로 넘어갑니다.

### 2회차에서 달라진 것

- **새 점검은 12번부터 25번까지입니다.** 1회차(2026-10-29, develop `d4831ff1`)에 없던 기능을 Mac 에서 처음 봅니다.
- **26~30번은 원격 Runtime 관리(Control Plane Phase 12)입니다.** 이 Mac 하나에서 개발용 앱을, 결과 폴더 안의 따로 된
  프로필로 띄운 Runtime 과 페어링합니다. 25 뒤에 개발용 앱을 다시 띄우고, 30 의 끝에서 다시 끕니다.
- **1~11번은 다시 합니다.** 모두 통과했지만, 그 뒤로 sandbox 코드가 바뀌었습니다. Job 의 완료 검사를 워커와 같은
  sandbox 안에서 돌리게 되었고, sandbox 세션의 에이전트 브라우저가 따로 만든 빈 저장소를 쓰게 되었고, Codex sandbox 를
  손본 수정이 여럿 들어갔습니다. 1~11 가운데 바뀐 곳은 점검 4(토큰 줄, 워커가 줄을 건너뛸 때 적을 것)와 점검 9 의
  마지막 줄(앱 작업 공간을 점검 22 까지 켜 둠)입니다. 준비 1 과 준비 2 도 조금 바뀌었습니다.
- **점검마다 `누가:` 줄이 있습니다.** `에이전트도` 는 1회차처럼 이 Mac 의 Claude Code 에이전트가 대신 할 수 있다는
  뜻입니다. 개발용 앱을 에이전트 앱 작업 공간에서 화면에 보이지 않게 띄우고, 세션에는 개발용 Host 의
  `astera sessions send` 로 붙여 넣고 `astera sessions read` 로 읽습니다. `사람만` 은 Mac 앞의 사람만 할 수 있는
  점검입니다(트랙패드, macOS 의 한글 입력, 화면에 보이는 창의 Cmd+Q). 에이전트와 사람이 나눠 할 때의 순서는 README 의
  '에이전트와 사람이 나눠 할 때' 에 있습니다.
- **알고 있는 것, 점검하지 않는 것.** Claude 세션에서 `!` 를 붙여 친 명령은 sandbox 밖에서 돕니다(1회차 점검 2 의
  메모). 사람이 직접 친 명령이라 그렇게 만들어져 있고, **Security & Access** 의
  **Sandbox가 막는 범위** (What the sandbox blocks) 표 아래에도 적혀 있습니다. 이 점검표의 명령을 `!` 로 대신 치지
  마세요.

## 자동 점검 결과

`run.sh` 가 아래 칸을 채웁니다. 직접 고치지 마세요.

<!-- run.sh summary start -->
```text
Astera mac-check, 2026-11-02 10:00:25
결과 폴더: ~/astera-mac-check-2026-11-02

== 1. 준비물 ==
NOTE  macOS                  26.3.1 arm64
NOTE  checkout               ~/Astera (develop 8ad27fd9)
PASS  node                   24.16.0 (22.13.0 이상; CI 는 22 를 씁니다)
NOTE  npm                    11.13.0
PASS  npm ci                 node_modules 가 package-lock.json 과 같고 Electron 이 있습니다
PASS  xterm-patch            node_modules 의 xterm.js 에 한글 입력 패치가 들어 있습니다
PASS  claude                 2.1.314 (2.1.306 이상) ~/.local/bin/claude
PASS  codex                  0.165.0 (0.160.0 이상) ~/.local/bin/codex

== 2. 로그인 정보 폴더와 링크 (있는지만 봅니다. 열지 않습니다) ==
NOTE  ~/.ssh                 있음
NOTE  ~/.aws                 있음
NOTE  ~/.config/gh           있음
NOTE  ~/.config/gcloud       없음
NOTE  ~/.docker              없음
NOTE  ~/.kube                있음
NOTE  ~/.npmrc               없음
NOTE  ~/.git-credentials     없음
NOTE  ~/Library/Keychains    있음
NOTE  links                  위 폴더 가운데 링크는 없습니다 (점검 11 은 건너뜁니다)
NOTE  gh                     있음: /opt/homebrew/bin/gh (점검 16)

== 3. lsof 와 ps ==
PASS  lsof-held              열어 둔 파일: 이 셸(28120)을 찾았습니다, 349 ms
PASS  lsof-free              닫힌 파일: 아무도 열지 않았다고 답합니다 (종료 코드 1, 출력 없음), 134 ms
PASS  ps-tree                pid ppid pgid, 이 셸의 줄: 28120 28115 28115, 39 ms
PASS  ps-parents             pid ppid, /bin/ps 가 이 셸을 보여 줍니다

== 4. 빌드 ==
PASS  build                  6 초, logs/build.log

== 5. 테스트 ==
PASS  posix-tree-kill        통과 46 / 실패 0 / 건너뜀 0 / 모두 46, 3 초, logs/posix-tree-kill.log
PASS  mac-desk               통과 42 / 실패 0 / 건너뜀 0 / 모두 42, 1 초, logs/mac-desk.log
PASS  mac-desk-e2e           통과 1 / 실패 0 / 건너뜀 0 / 모두 1, 2 초, logs/mac-desk-e2e.log
PASS  manual-install         통과 12 / 실패 0 / 건너뜀 0 / 모두 12, 0 초, logs/manual-install.log
PASS  rollout-owner          통과 77 / 실패 0 / 건너뜀 3 / 모두 80, 0 초, logs/rollout-owner.log
PASS  sandbox-builders       통과 344 / 실패 0 / 건너뜀 6 / 모두 350, 3 초, logs/sandbox-builders.log

== 6. 안내 점검에 쓸 작업 폴더 ==
PASS  work                   저장소 ~/astera-mac-check-2026-11-02/work/mac-check-repo, worktree ~/astera-mac-check-2026-11-02/work/mac-check-repo-wt
PASS  helpers                ~/astera-mac-check-2026-11-02/env.sh, ~/astera-mac-check-2026-11-02/dev-astera, ~/astera-mac-check-2026-11-02/runtime-astera, ~/astera-mac-check-2026-11-02/work/ext/mac-check-skill

== 7. 다음 ==
PASS  total                  실패 없음
다음: ~/astera-mac-check-2026-11-02/checklist.md 를 열어 '준비' 부터 차례로 하세요.
```
<!-- run.sh summary end -->

## 준비

### 준비 1. 터미널의 변수

이 점검표의 터미널 명령은 결과 폴더를 `R`, 저장소 폴더를 `REPO` 라는 이름으로 씁니다. `run.sh` 가 둘을 결과 폴더의
`env.sh` 에 적어 두었습니다. 터미널 창을 새로 열 때마다 먼저 이 줄을 칩니다.

```sh
. "$(ls -d ~/astera-mac-check-* | tail -n 1)/env.sh"; echo "$R"; echo "$REPO"
```

`/Users/<이름>/astera-mac-check-<날짜>` 와 저장소 폴더가 나오면 됩니다.

`"$R/dev-astera"` 는 개발용 앱의 `astera` 입니다. 개발용 Host 와 그 프로필 폴더(`astera-dev`)에만 말을 걸고, 설치된
Astera 에는 닿지 않습니다. 몇몇 점검이 터미널에서 이것으로 개발용 Host 에 묻습니다.

### 준비 2. 개발용 앱 띄우기

1. 터미널 창을 하나 더 열고 저장소 폴더로 갑니다(`cd "$REPO"`).
2. 개발용 Host 가 이전에 띄운 채로 남아 있지 않은지 봅니다. 아무 줄도 없어야 합니다.

   ```sh
   ps -Ao pid,command | grep '[n]ode_modules/electron/dist/Electron.app' | grep 'host.js'
   ```

   줄이 있으면 1분쯤 기다렸다가 다시 봅니다. 그래도 남아 있으면 그 줄 맨 앞의 숫자로 `kill <숫자>` 를 칩니다.
3. 다음 줄로 앱을 띄웁니다. 이 창은 앱을 끌 때까지 그대로 둡니다. 앞의 `MAC_CHECK_TOKEN` 은 점검 16 이 숨겨 볼 가짜
   변수입니다. 값은 비밀이 아니고, 어디에도 출력하지 않습니다. 에이전트가 앱 작업 공간에서 띄울 때도 이 변수를 넣습니다.

   ```sh
   MAC_CHECK_TOKEN=mac-check-not-a-secret npm run dev
   ```

4. 앱 창이 뜨고 **새 세션을 무엇으로 시작할까요?** (What should new sessions be?) 라고 물으면 **터미널** (Terminal)
   을 고릅니다.
5. 앱이 뜨고 몇 초 뒤, 다른 터미널 창에서 개발용 프로필 폴더가 생겼는지 봅니다.

   ```sh
   ls "$HOME/Library/Application Support/astera-dev/host"
   ```

통과: `host.key` 가 목록에 있습니다. 설치된 Astera 의 폴더(`~/Library/Application Support/Astera`)가 아니라
`astera-dev` 입니다.

- [x] 통과
- [ ] 실패

메모:

1회차처럼 개발용 앱을 에이전트 앱 작업 공간에서 띄웠습니다(`npm run dev` 대신 `Electron.app/Contents/MacOS/Electron`
과 `out/` 빌드). `MAC_CHECK_TOKEN=mac-check-not-a-secret` 을 명령 앞에 붙여 넣었고, main 프로세스의 환경에 들어간 것을
inspector 로 확인했습니다. 띄우기 전에 남은 개발용 Host 는 없었습니다. 개발용 프로필이 1회차부터 있어서 **새 세션을
무엇으로 시작할까요?** 는 뜨지 않았습니다. 앱은 창을 보일 때 앞으로 나오므로, inspector 가 답하자마자 `app.hide()` 로
숨겼습니다. `host` 폴더: `app.key host-stderr.log host.key host.log host.pid rolling.json`.

### 준비 3. 계정 등록 (새 로그인 없이)

1. 앱 왼쪽 세로 막대에서 **계정과 히스토리** (Accounts and history) 를 누릅니다.
2. 처음이면 **감지된 계정** (Detected accounts) 창이 저절로 뜹니다. 안 뜨면 계정 칸 위쪽의 **자동 감지** (Auto-detect)
   아이콘(둥근 화살표)을 누릅니다.
3. 경로가 `/Users/<이름>/.claude` 인 Claude 항목과 `/Users/<이름>/.codex` 인 Codex 항목만 체크된 채로 두고, 다른 항목은
   체크를 끕니다. 두 항목 모두 **로그인됨** (Logged in) 이어야 합니다.
4. **선택 등록** (Register selected) 을 누릅니다.
5. 로그인이 `~/.claude`, `~/.codex` 가 아니라 설치된 Astera 에서 **추가** (Add) 로 만든 계정 폴더
   (`~/.claude-accounts/<이름>`, `~/.codex-accounts/<이름>`)에 있으면, 감지된 계정 창에 나오지 않습니다. 그때는 계정 칸
   위쪽의 **가져오기** (Import) 아이콘(폴더 모양)을 누르고 그 폴더를 고릅니다. 종류(Claude 나 Codex)와 라벨이 채워지면
   아래의 **가져오기** (Import) 를 누릅니다. 이것도 새 로그인을 만들지 않습니다.

하지 말 것: 계정 칸 위쪽의 + 버튼, **추가** (Add) 로 계정을 새로 만들지 않습니다(새 로그인을 만들고 키체인에 새 항목을
씁니다). 계정의 로그아웃도 하지 않습니다. 혹시 macOS 가 키체인 접근을 묻는 창을 띄우면 거부를 누릅니다.

통과: 계정 칸에 두 계정이 보이고, 새 로그인 화면은 한 번도 뜨지 않았습니다.

- [x] 통과
- [ ] 실패

메모:

1회차에 등록한 두 계정이 그대로 있습니다: Claude(`~/.claude`), Codex(`~/.codex-accounts/<계정>`, 1회차에 가져오기로 등록).
새 로그인이나 키체인 질문은 없었습니다.

### 준비 4. 에이전트 프로필 세 개

1. 왼쪽 세로 막대 맨 아래의 톱니바퀴, **설정** (Settings) 을 누르고 **에이전트 프로필** (Agent profiles) 로 갑니다.
2. **새 프로필** (New profile) 을 누르고 다음처럼 채운 뒤 **만들기** (Create) 를 누릅니다.
   - **이름** (Name): `mac-check`
   - 편집 칸 안의 **계정 추가** (Add account) 목록을 펼쳐 준비 3에서 등록한 Claude 계정을 고릅니다. 새 계정을 만드는
     것이 아니라 등록된 계정을 고르는 목록입니다.
   - **권한 확인** (Permission checks): **앱 설정 따름** (Follow the app setting) 그대로 둡니다.
   - **Sandbox에서 실행** (Run in the sandbox): 켭니다.
3. 같은 방법으로 하나 더: 이름 `mac-check-codex`, Codex 계정, **Sandbox에서 실행** (Run in the sandbox) 켬.
4. 하나 더: 이름 `mac-check-plain`, Claude 계정, **Sandbox에서 실행** (Run in the sandbox) 끔. 점검 8과 9에서 sandbox
   밖과 비교하는 데 씁니다.

프로필 하나에는 한 CLI 의 계정만 넣을 수 있어서 Claude 용과 Codex 용을 따로 만듭니다.

통과: 목록에 세 프로필이 보입니다.

- [x] 통과
- [ ] 실패

메모:

1회차에 만든 세 프로필이 그대로 있습니다: `mac-check`(sandbox 켬), `mac-check-plain`(끔), `mac-check-codex`(켬).

### 세션을 여는 법 (점검마다 씁니다)

1. 탭 줄 오른쪽의 **+** 를 누릅니다. 마우스를 올리면 **새 세션** (New session) 이라고 나옵니다. 탭이 하나도 없으면 가운데의
   **+ 새 세션으로 시작하세요** (+ Start a new session) 를 누릅니다.
2. **세션 방식** (Session type) 에서 **터미널** (Terminal) 이나 **대화** (Chat) 를 고릅니다.
3. **프로젝트 폴더** (Project folder) 의 **선택…** (Select…) 을 누릅니다. 폴더 고르는 창에서 Cmd+Shift+G 를 누르고
   점검이 말하는 경로를 붙여 넣은 뒤 열기를 누릅니다. `<날짜>` 는 준비 1의 `echo "$R"` 에 나온 날짜입니다.
4. 폴더를 고르면 나타나는 **worktree로 분리해서 시작** (Start in a separate worktree) 은 끈 채로 둡니다.
5. **에이전트 프로필** (Agent profile) 에서 점검이 말하는 프로필을 고릅니다.
6. **시작** (Start) 을 누릅니다.
7. Claude 나 Codex 가 이 폴더를 믿을지 물으면 믿는다고 답합니다.

폴더 고르는 창은 macOS 의 창이라 사람만 다룰 수 있습니다. 에이전트는 1회차처럼 개발용 앱의 main 프로세스에서
`dialog.showOpenDialog` 를 바꿔치기해 경로를 넘깁니다. 그렇게 inspector 로 main 프로세스에 붙었다면, 앱을 끄기 전에
그 연결을 닫습니다(점검 24).

sandbox 로 시작한 세션은 탭 이름 옆에 방패 아이콘이 있습니다. 마우스를 올리면
**Sandbox 안에서 실행 중** (Running in the sandbox) 이라고 나옵니다.

붙여 넣을 글은 코드 칸 하나를 통째로 복사해 세션에 붙여 넣고 Enter 를 누릅니다. 대화 세션이면 아래쪽 입력칸
**무엇을 시킬까요** (What should it do) 에 붙여 넣고 보냅니다.

## 1. sandbox 안의 Claude 터미널 세션, 보통 일

누가: 에이전트도

약 4분. 세션: 프로필 `mac-check`, **터미널** (Terminal), 폴더 `~/astera-mac-check-<날짜>/work/mac-check-repo`.

탭에 방패 아이콘이 있는지 먼저 봅니다. 그다음 붙여 넣습니다.

```text
Astera mac-check 1번입니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하세요. 실패한 명령은 다시 시도하지 말고 다른 방법도 찾지 마세요. 실패도 결과입니다. 명령을 고치거나 덧붙이지 말고, 다른 파일은 만들거나 고치지 마세요. astera 로 시작하는 줄은 그 줄만 따로 실행하세요. 끝나면 각 명령의 출력을 그대로 보여 주세요. 단, astera help 는 출력의 첫 줄만 보여 주면 됩니다.

echo "TMPDIR=$TMPDIR"
echo tmp-ok > "${TMPDIR:-/tmp}/mac-check-1.txt" && cat "${TMPDIR:-/tmp}/mac-check-1.txt" && rm "${TMPDIR:-/tmp}/mac-check-1.txt"
echo work-ok > mac-check-1.txt && cat mac-check-1.txt
git add -A && git commit -q -m "mac-check 1: sandboxed commit" && git log --oneline -1
npm init -y > /dev/null && npm install --no-audit --no-fund --loglevel=error is-number@7.0.0 && ls node_modules
astera help
astera sessions list --status alive
```

통과:

- 탭에 방패 아이콘이 있습니다.
- `TMPDIR=` 뒤에 경로가 나오고(그 경로를 적어 주세요), `tmp-ok` 와 `work-ok` 가 나옵니다.
- `git log` 가 `mac-check 1: sandboxed commit` 한 줄을 보여 줍니다.
- `ls node_modules` 에 `is-number` 가 있습니다. Claude Code 가 `registry.npmjs.org` 같은 곳에 접속해도 되냐고 물었다면
  한 번 허락하고, 물었다는 사실을 메모에 적어 주세요.
- `astera help` 의 첫 줄이 `# Cross-vendor orchestration — full guide` 입니다.
- `astera sessions list` 의 출력이 `{"ok":true` 로 시작하고, 이 세션이 들어 있습니다.

- [x] 통과
- [ ] 실패

메모:

`sessions list` 의 `"sandboxed":true`. `TMPDIR` 은 `/tmp/claude-501`. 접속을 묻는 질문은 없었습니다.

출력:

```text
TMPDIR=/tmp/claude-501
tmp-ok
work-ok
1a3069e mac-check 1: sandboxed commit
added 1 package in 197ms
is-number
# Cross-vendor orchestration — full guide
{"ok":true,"data":{"sessions":[{"id":"566b3127-…","kind":"terminal","title":"mac-check-repo",…,"cwd":"~/astera-mac-check-2026-11-02/work/mac-check-repo","alive":true,"state":"working","provider":"claude","agentProfileId":"ap_b4ca7a93ed14","sandboxed":true,"sandboxKind":"sandbox",…}]}}
```

## 2. 같은 세션, 막혀야 하는 것

누가: 에이전트도

약 3분. 점검 1의 세션에 이어서 붙여 넣습니다.

Claude 가 이 글에서 멈추고 Opus 4.8 로 바꿀지 물을 수 있습니다. 로그인 정보 폴더를 묻는 글을 Opus 5.5 의 safeguards 가
막기 때문입니다. 처음 뜨는 `Model switch` 창에서 `Switch automatically` 를 고르면 Opus 4.8 로 이어집니다. 다만 앞으로도
묻지 않고 바꾸는 설정이 남습니다(그 창의 말대로 `/config` 에서 되돌립니다). 설정을 남기기 싫으면 `Stay on Opus 5.5` 를
고르고, 같은 글을 다시 붙여 넣은 뒤 다음에 뜨는 `Session paused` 창에서 `Switch to Opus 4.8` 을 고릅니다. 어느 쪽이든
메모에 적어 주세요.

```text
Astera mac-check 2번입니다. 규칙은 같습니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하고, 실패해도 다시 시도하거나 다른 방법을 찾지 마세요. 여기 있는 명령은 대부분 실패하는 것이 정상입니다. 끝나면 각 명령의 출력을 그대로 보여 주세요.

for p in ~/.ssh ~/.aws ~/.config/gh ~/.config/gcloud ~/.docker ~/.kube ~/.npmrc ~/.git-credentials ~/Library/Keychains; do ls "$p" > /dev/null; echo "$p exit=$?"; done
security list-keychains; echo "exit=$?"
security find-generic-password -s astera-mac-check-none > /dev/null; echo "exit=$?"
echo x > "$HOME/Library/Application Support/astera-dev/mac-check-write.txt"; echo "exit=$?"
wc -c < "$HOME/Library/Application Support/astera-dev/host/host.key"; echo "exit=$?"
wc -c < "$HOME/Library/Application Support/astera-dev/host/app.key"; echo "exit=$?"
```

통과:

- `~/Library/Keychains` 는 `Operation not permitted` 와 `exit=1` 입니다.
- 자동 점검 결과의 2절에서 '있음' 이었던 폴더와 파일은 모두 `Operation not permitted` 와 `exit=1` 입니다. '없음' 이었던
  것은 `No such file or directory` 여도 됩니다.
- `security list-keychains` 는 키체인 경로 목록을 보여 줄 수도 있습니다. 그것만으로는 실패가 아닙니다. 출력만 붙여
  넣어 주세요. Claude 의 sandbox 안에서는 `/Library/Keychains/System.keychain` 만 나오고, 밖(점검 8)에서는
  `login.keychain-db` 도 나옵니다.
- `security find-generic-password` 는 여기서도 `The specified item could not be found in the keychain.` 과 `exit=44`
  일 수 있습니다. 실패가 아닙니다. 안에서는 검색 목록에 시스템 키체인만 있어서, 그곳만 찾아보고 없다고 답한 것입니다.
- 프로필 폴더에 쓰기(`mac-check-write.txt`)는 `Operation not permitted` 와 `exit=1` 이거나, Claude Code 가
  `Permission to use Bash … has been denied` 라며 아예 실행하지 않습니다. 둘 다 막힌 것입니다.
- `host.key` 는 `64` 와 `exit=0` 입니다. 세션 안의 `astera` 가 Host 를 확인하는 데 이 파일을 읽어야 합니다.
- `app.key` 는 숫자 없이 `Operation not permitted`(또는 비슷한 거절)와 `exit=1` 이거나, 위처럼
  `Permission to use Bash … has been denied` 입니다.

- [x] 통과
- [ ] 실패

메모:

1회차와 달리 Opus 5.5 가 멈추지 않고 끝까지 돌렸습니다(`Model switch`·`Session paused` 창 없음, Claude Code 2.1.314).
프로필 폴더 쓰기와 `app.key` 는 Claude Code 의 권한 규칙이 실행 전에 거절했고 `mac-check-write.txt` 는 생기지
않았습니다. 세션은 스스로 "4번과 6번은 권한 단계에서 거부돼 sandbox 가 막는지는 이 결과로 볼 수 없다" 고 덧붙였습니다.

출력:

```text
ls: ~/.ssh: Operation not permitted
~/.ssh exit=1
ls: ~/.aws: Operation not permitted
~/.aws exit=1
ls: ~/.config/gh: Operation not permitted
~/.config/gh exit=1
ls: ~/.config/gcloud: No such file or directory
~/.config/gcloud exit=1
ls: ~/.docker: No such file or directory
~/.docker exit=1
ls: ~/.kube: Operation not permitted
~/.kube exit=1
ls: ~/.npmrc: No such file or directory
~/.npmrc exit=1
ls: ~/.git-credentials: No such file or directory
~/.git-credentials exit=1
ls: ~/Library/Keychains: Operation not permitted
~/Library/Keychains exit=1
    "/Library/Keychains/System.keychain"
exit=0
security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.
exit=44
Permission to use Bash with command echo x > "$HOME/Library/Application Support/astera-dev/mac-check-write.txt"; echo "exit=$?" has been denied.
      64
exit=0
Permission to use Bash with command wc -c < "$HOME/Library/Application Support/astera-dev/host/app.key"; echo "exit=$?" has been denied.
```

이 세션은 이제 닫아도 됩니다(탭의 **닫기** (Close)).

## 3. sandbox 안의 Claude 대화 세션

누가: 에이전트도

약 3분. 세션: 프로필 `mac-check`, **대화** (Chat), 폴더 `~/astera-mac-check-<날짜>/work/mac-check-repo`.

```text
Astera mac-check 3번입니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하세요. 실패해도 다시 시도하거나 다른 방법을 찾지 말고, 명령을 고치거나 덧붙이지 마세요. astera 로 시작하는 줄은 그 줄만 따로 실행하세요. 끝나면 각 명령의 출력을 그대로 보여 주세요.

echo "TMPDIR=$TMPDIR"
echo tmp-ok > "${TMPDIR:-/tmp}/mac-check-3.txt" && cat "${TMPDIR:-/tmp}/mac-check-3.txt" && rm "${TMPDIR:-/tmp}/mac-check-3.txt"
echo chat-ok > mac-check-3.txt && git add -A && git commit -q -m "mac-check 3: sandboxed chat commit" && git log --oneline -1
astera sessions list --status alive
```

통과: 탭에 방패 아이콘이 있습니다. `tmp-ok`, `git log` 의 `mac-check 3: sandboxed chat commit` 한 줄, `{"ok":true` 로
시작하는 세션 목록이 나옵니다. 승인 카드가 떴다면 무엇을 묻는 카드였는지 메모에 적어 주세요.

- [x] 통과
- [ ] 실패

메모:

`"sandboxed":true`, 승인 카드는 뜨지 않았습니다. `git add -A` 가 점검 1 에서 남은 `package.json`, `package-lock.json` 도
같이 커밋했습니다. 점검 4 가 `mac-check-repo` 탭을 앞에 두라고 해서, 이 세션은 점검 4 가 끝날 때까지 열어 두었습니다.

출력:

```text
TMPDIR=/tmp/claude-501
tmp-ok
ebd9cca mac-check 3: sandboxed chat commit
{"ok":true,"data":{"sessions":[{"id":"c71344b5-…","kind":"chat","title":"mac-check-repo",…,"cwd":"~/astera-mac-check-2026-11-02/work/mac-check-repo","alive":true,"state":"unknown","provider":"claude","agentProfileId":"ap_b4ca7a93ed14","sandboxed":true,"sandboxKind":"sandbox",…}]}}
```

다 보면 이 세션을 닫습니다.

## 4. sandbox 안의 Codex, Job 의 워커로

누가: 에이전트도

약 6분. 워커는 Job 이 띄우는 Codex 터미널 세션입니다. 워커가 점검 1과 2의 명령을 돌리고, 평소 워커처럼 `astera` 로
결과를 보고합니다.

1. `mac-check-repo` 폴더의 세션 탭이 앞에 있는 상태에서(없으면 아무 프로필로 그 폴더의 세션을 하나 엽니다) 왼쪽
   세로 막대의 Jobs 를 누릅니다.
2. **새 작업** (New job) 을 누르고 다음처럼 채운 뒤 **만들기** (Create) 를 누릅니다.
   - **목표** (Objective): `mac-check 4`
   - **에이전트 프로필** (Agent profile): `mac-check-codex`
   - **코디네이터 계정** (Coordinator account): Codex 계정
   - 나머지는 그대로 둡니다.
3. 방금 만든 작업의 상세 창에서 **Task 추가** (Add task) 를 누르고 다음처럼 채운 뒤 **추가** (Add) 를 누릅니다.
   - **제목** (Title): `mac-check 4`
   - **에이전트 프로필** (Agent profile): Job 의 프로필(`mac-check-codex`)을 따르는 첫 항목 그대로 둡니다.
   - **계정** (Account): Codex 계정(이미 골라져 있으면 그대로).
   - **지시** (Instructions): 아래 글을 통째로 붙여 넣습니다.
4. 상세 창의 **실행** (Run) 을 누릅니다. 상세 창이 닫혀 있으면 Jobs 목록에서 그 작업을 누르면 열립니다.
5. 코디네이터 탭과 워커 탭이 생깁니다. 코디네이터(작업을 관리하는 세션)는 프로필을 따르지 않아 sandbox 밖에서 돌고,
   그대로 두면 됩니다. 워커 탭을 눌러 지켜봅니다. 폴더를 믿을지 물으면 믿는다고 답합니다.

```text
Astera mac-check 4번(Codex 워커)입니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하세요. 실패한 명령은 다시 시도하지 말고 다른 방법도 찾지 마세요. 실패도 결과이고, 뒤쪽 명령은 대부분 실패하는 것이 정상입니다. 명령을 고치거나 덧붙이지 마세요. astera 로 시작하는 줄은 그 줄만 따로 실행하세요. astera help 는 출력의 첫 줄만 보여 주면 됩니다. 다 끝나면 각 명령의 출력을 한데 모아 보여 주고, 평소 워커처럼 astera 로 이 Task 가 끝났다고 보고하세요.

echo "TMPDIR=$TMPDIR"
echo tmp-ok > "${TMPDIR:-/tmp}/mac-check-4.txt" && cat "${TMPDIR:-/tmp}/mac-check-4.txt" && rm "${TMPDIR:-/tmp}/mac-check-4.txt"
echo work-ok > mac-check-4.txt && cat mac-check-4.txt
git add -A && git commit -q -m "mac-check 4: sandboxed worker commit" && git log --oneline -1
npm init -y > /dev/null && npm install --no-audit --no-fund --loglevel=error is-number@7.0.0 && ls node_modules
echo "ASTERA_LOOPBACK=$ASTERA_LOOPBACK"
astera help
astera sessions list --status alive
for p in ~/.ssh ~/.aws ~/.config/gh ~/.config/gcloud ~/.docker ~/.kube ~/.npmrc ~/.git-credentials ~/Library/Keychains; do ls "$p" > /dev/null; echo "$p exit=$?"; done
security list-keychains; echo "exit=$?"
security find-generic-password -s astera-mac-check-none > /dev/null; echo "exit=$?"
echo x > "$HOME/Library/Application Support/astera-dev/mac-check-write.txt"; echo "exit=$?"
wc -c < "$HOME/Library/Application Support/astera-dev/host/host.key"; echo "exit=$?"
wc -c < "$HOME/Library/Application Support/astera-dev/host/app.key"; echo "exit=$?"
```

통과:

- 워커 탭에 방패 아이콘이 있습니다.
- 앞쪽(보통 일)은 점검 1과 같습니다. 다만 이 sandbox 안의 `astera` 는 출력 맨 앞에
  `task_name_for_pid: (os/kern) failure (5)` 가 든 `ERROR` 줄을 하나 붙일 수 있습니다. 그 줄은 빼고 봅니다.
  `ASTERA_LOOPBACK=` 뒤에 `http://127.0.0.1:` 로 시작하는 주소가 나옵니다. Codex 의 sandbox 는 Host 의 소켓 폴더를
  막으므로, 이 세션의 `astera` 는 이 주소로 Host 에 닿습니다.
- 뒤쪽(막혀야 하는 것)은 점검 2와 같습니다. 워커가 로그인 정보 폴더, `security`, `app.key` 줄을 금지된 접근이라며
  건너뛸 수 있습니다. Codex 의 모델이 스스로 그렇게 합니다(1회차에도 그랬습니다). 그러면 건너뛴 줄을 메모에 그대로
  적고, 워커가 든 이유를 한 줄 옮겨 둡니다. 이 줄들이 Codex 의 sandbox 에서 막히는지는 CI 의 sandbox 측정
  (`.github/workflows/measure-sandbox.yml`, macOS 러너)이 Astera 의 탐침으로 따로 잽니다. 그래서 건너뛴 줄이 있어도,
  앞쪽 보통 일과 프로필 폴더 쓰기 차단이 맞고 보고가 Host 에 닿았으면 통과로 표시합니다.
- Job 상세 창에 워커의 보고가 나타나고, Task 의 상태가 **끝났다** (Done) 로 바뀝니다. 워커가 줄을 건너뛰어 실패로
  보고했다면 상태는 실패가 되지만, 보고가 나타난 것만으로 워커가 sandbox 안에서 `astera` 로 보낸 보고가 Host 에 닿았다는
  뜻입니다. 코디네이터가 다시 할지 물으면 답하지 않고 두어도 됩니다.
- 워커가 끝나면 Job 상세 창 위쪽에 이 Run 이 쓴 토큰이 나옵니다: `토큰 <수> (입력 <수>, 출력 <수>)` 와
  `코디네이터 토큰 <수> (입력 <수>, 출력 <수>)` 두 줄(영어로는 `Tokens …` 와 `Coordinator tokens …`). 그래프에서 워커
  Task 를 누르면 `토큰 <수>` 칩도 붙습니다. Claude 와 Codex 가 남긴 기록에서 읽은 수입니다. 세 수를 메모에 적어 주세요.
  줄이 나오지 않아도 이 점검의 실패는 아니고, 그렇게 메모합니다.

- [x] 통과
- [ ] 실패

메모:

워커는 sandbox 안(`sandboxed: true`), worktree 는 `~/astera-worktrees/mac-check-repo/mac-check-4-2`. 워커(GPT-6.1-Sol)는
로그인 정보 폴더 반복문, `security find-generic-password`, `app.key` 줄을 건너뛰었습니다. 든 이유: "The session's access
policy prohibits the listed credential-directory reads and the `host/app.key` read, so I'll skip those". 1회차와 달리
`security list-keychains` 는 돌렸습니다. 보고는 `--outcome failed` 로 Host 에 닿았고(`accepted`), 상세 창에 "워커 보고
실패" 와 "결정 대기" 가 나왔습니다. 코디네이터의 질문에는 답하지 않았습니다.

토큰: 처음 띄운 앱에서는 상세 창 위쪽의 두 줄도, Task 의 토큰 칩도 나오지 않았습니다(창을 다시 열어도 같음). 그때도 Host
(`dev-astera runs get`)와 앱의 `audit.runTokens` 는 숫자를 돌려주고 있었습니다. 점검 18 도중 앱을 다시 띄운 뒤 같은 상세 창을 열자
두 줄이 나왔습니다: `토큰 135,788 (입력 134,265, 출력 1,523)`, `코디네이터 토큰 530,120 (입력 528,751, 출력 1,369)`. 처음 앱에서
상세 창이 토큰을 읽지 못한 까닭은 따로 볼 일입니다.

**이후(점검 뒤 고침, `b2d49fab`):** 원인을 재현했습니다. 열린 Run 상세는 Run 의 상태가 바뀔 때만 토큰을 다시 읽는데,
워커는 보고한 뒤에도 자기 턴을 마치고 코디네이터는 보고에 답하느라 토큰을 더 씁니다. 그래서 상세 창은 보고 순간에 읽은
값에 멈춥니다(재현: 화면 83,531 / 200,150, Host 142,943 / 308,915). 이 점검에서는 그 순간 토큰이 아직 세어지지 않아 줄이
아예 없었습니다. "창을 다시 열어도 같음" 은 에이전트가 창을 실제로 닫지 못한 탓으로 보입니다. 이제 읽은 값이 바뀌는 동안
30초마다 다시 읽고 두 번 같으면 멈춥니다(고친 앱에서 15초 안에 Host 값과 같아짐).

출력:

```text
TMPDIR=/var/folders/…/T/
tmp-ok
work-ok
6b3b56d mac-check 4: sandboxed worker commit
added 1 package in 115ms
is-number
ASTERA_LOOPBACK=http://127.0.0.1:57406
[1102/100617.942608:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)
# Cross-vendor orchestration — full guide
[1102/100620.438259:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)
{"ok":true,"data":{"sessions":[…코디네이터, mac-check 4(워커, "sandboxed":true), mac-check-repo…]}}
(로그인 정보 폴더 반복문: 워커가 건너뜀)
    "/Library/Keychains/System.keychain"
exit=0
(security find-generic-password: 워커가 건너뜀)
zsh:1: operation not permitted: ~/Library/Application Support/astera-dev/mac-check-write.txt
exit=1
      64
exit=0
(app.key: 워커가 건너뜀)
astera send --type worker_done … --outcome failed
{"ok":true,"data":{"value":"accepted"}}
```

## 5. sandbox 안의 Codex 대화: 끝냈다가 히스토리에서 이어하기

누가: 에이전트도

약 5분. 세션: 프로필 `mac-check-codex`, **대화** (Chat), 폴더 `~/astera-mac-check-<날짜>/work/mac-check-repo`.

1. 세션을 열고 다음 글을 보냅니다.

   ```text
   Astera mac-check 5번(첫 부분)입니다. 아래 명령 한 줄을 한 번만 그대로 실행하고 출력을 보여 주세요.

   pwd; echo chat5-ok > mac-check-5.txt && cat mac-check-5.txt
   ```

2. 답이 오면 탭의 **닫기** (Close) 로 세션을 끝냅니다.
3. **계정과 히스토리** (Accounts and history) 의 히스토리에서 `mac-check-repo` 를 펼치고, 방금 대화를 찾아 **세션 이어하기**
   (Resume session) 를 누릅니다.
4. 열린 창의 **세션 방식** (Session type) 에서 **대화** (Chat) 를 고르고(처음에는 준비 2 에서 고른 **터미널** (Terminal)
   이 골라져 있습니다), 창에
   **에이전트 프로필 'mac-check-codex'(으)로 이어집니다.** (This conversation resumes as the agent profile “mac-check-codex”.)
   라는 줄이 있는지 본 뒤 **이어하기** (Resume) 를 누릅니다.
5. 이어진 대화에 다음 글을 보냅니다.

   ```text
   Astera mac-check 5번(이어서)입니다. 아래 명령을 한 줄씩 한 번만 그대로 실행하고, 실패해도 다시 시도하거나 다른 방법을 찾지 마세요. 둘째 줄은 실패하는 것이 정상입니다. 각 명령의 출력을 그대로 보여 주세요.

   echo resumed-ok > mac-check-5b.txt && cat mac-check-5b.txt
   echo x > ../mac-check-outside.txt; echo "exit=$?"
   ```

6. 터미널에서 작업 폴더 바깥에 파일이 생기지 않았는지 봅니다.

   ```sh
   ls "$R/work"
   ```

통과: 처음 세션과 이어진 세션 모두 탭에 방패 아이콘이 있습니다. 이어하기 창에 위의 프로필 줄이 있었습니다.
`resumed-ok` 가 나오고, 바깥 쓰기는 `Operation not permitted` 와 `exit=1` 입니다. `ls "$R/work"` 에
`mac-check-outside.txt` 가 없습니다.

- [x] 통과
- [ ] 실패

메모:

처음 대화와 이어진 대화 모두 `sandboxed: true`(`sessions list`). 이어하기 창은 1회차처럼 세션 방식이 터미널로 골라져
있어서 **대화** 를 골랐고, 프로필 줄("에이전트 프로필 'mac-check-codex'(으)로 이어집니다.")이 있었습니다.

출력:

```text
~/astera-mac-check-2026-11-02/work/mac-check-repo
chat5-ok
--- 이어서
resumed-ok
zsh:1: operation not permitted: ../mac-check-outside.txt
exit=1
--- ls "$R/work"
ext
mac-check-repo
mac-check-repo-wt
```

다 보면 이 세션을 닫습니다.

## 6. worktree 세션

누가: 에이전트도

약 4분. `run.sh` 가 만든 연결된 worktree(`mac-check-repo-wt`, 브랜치 `mac-check-wt`)에서 sandbox 세션이 git 을 쓸 수
있는지 봅니다. Claude 와 Codex 를 하나씩 엽니다.

6a. 세션: 프로필 `mac-check`, **터미널** (Terminal), 폴더 `~/astera-mac-check-<날짜>/work/mac-check-repo-wt`.

```text
Astera mac-check 6a번입니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하고, 실패해도 다시 시도하거나 다른 방법을 찾지 마세요. 각 명령의 출력을 그대로 보여 주세요.

git status --short --branch
echo wt-ok > mac-check-6a.txt && git add -A && git commit -q -m "mac-check 6a: worktree commit" && git log --oneline -1
```

6b. 세션: 프로필 `mac-check-codex`, **터미널** (Terminal), 같은 폴더.

```text
Astera mac-check 6b번입니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하고, 실패해도 다시 시도하거나 다른 방법을 찾지 마세요. 각 명령의 출력을 그대로 보여 주세요.

git status --short --branch
echo wt-ok > mac-check-6b.txt && git add -A && git commit -q -m "mac-check 6b: worktree commit" && git log --oneline -1
```

통과: 두 탭 모두 방패 아이콘이 있습니다. 둘 다 `git status` 가 `## mac-check-wt` 로 시작하고, `git log` 가 각자의
커밋 한 줄(`mac-check 6a: worktree commit`, `mac-check 6b: worktree commit`)을 보여 줍니다.

- [x] 6a 통과
- [x] 6b 통과
- [ ] 실패

메모:

두 탭 모두 방패 아이콘이 있었습니다(화면으로 확인). 이번에는 6a 와 6b 모두 폴더를 믿을지 묻지 않았습니다. 6b 는 1회차에
멈췄던 Codex sandbox 가 바로 일해 10초에 끝났습니다.

출력:

```text
6a
## mac-check-wt
93ba9c3 mac-check 6a: worktree commit
6b
## mac-check-wt
c6488a7 mac-check 6b: worktree commit
```

다 보면 두 세션을 닫습니다.

## 7. 홈 폴더에서 시작할 때의 경고

누가: 에이전트도

약 4분. 세션: 프로필 `mac-check`, **터미널** (Terminal), 폴더는 홈 폴더(`/Users/<이름>`, 폴더 고르는 창에서
Cmd+Shift+H).

1. 세션을 엽니다. 터미널 위에 방패 모양 아이콘과 함께 다음 경고 한 줄이 떠야 합니다.

   **이 sandbox 세션의 작업 폴더가 홈 폴더를 포함하고 있어서, sandbox 안에서 홈 폴더의 프로그램과 설정을 바꿀 수 있습니다. 이것들을 지키려면 프로젝트 폴더에서 시작해 주세요.** (This sandboxed session's work folder contains your home folder, so programs and settings in your home folder can be changed from inside the sandbox. Start it in a project folder to keep them out of reach.)

   한 줄에 다 안 들어가면 끝이 잘립니다. 마우스를 올리면 전체 문장이 보입니다. Claude 가 홈 폴더를 믿을지 물으면 믿는다고
   답합니다. 홈 폴더에 대한 이 답은 이 세션에만 쓰이고 `~/.claude.json` 에 남지 않습니다.
2. 다음 글을 붙여 넣습니다. 홈 폴더 전체를 쓸 수 있는 세션이어도, 개발용 앱의 프로필 폴더에는 쓸 수 없어야 합니다.

   ```text
   Astera mac-check 7번입니다. 아래 명령을 한 줄씩 한 번만 그대로 실행하고, 실패해도 다시 시도하거나 다른 방법을 찾지 마세요. 다른 파일은 만들거나 고치지 마세요. 각 명령의 출력을 그대로 보여 주세요.

   echo "PWD=$PWD"
   echo x > "$HOME/Library/Application Support/astera-dev/mac-check-write.txt"; echo "exit=$?"
   wc -c < "$HOME/Library/Application Support/astera-dev/host/host.key"; echo "exit=$?"
   ```

3. 경고 줄 오른쪽 끝의 **닫기** (Close)(X) 를 누릅니다. 다른 탭을 눌렀다가 이 탭으로 돌아옵니다.
4. 이 세션을 바로 닫습니다. 홈 폴더 전체를 쓸 수 있는 세션은 열어 두지 않습니다.

통과: 경고 줄이 떴고, 닫은 뒤 탭을 오가도 다시 나타나지 않았습니다. `PWD=` 가 홈 폴더이고, 프로필 폴더 쓰기는
`Operation not permitted` 와 `exit=1`(또는 점검 2처럼 `Permission to use Bash … has been denied`), `host.key` 는 `64` 와
`exit=0` 입니다.

자동 점검 결과의 2절에 링크인 폴더(예: `~/.config`)가 있으면, 이 세션은 시작되지 않고 다음 문장으로 거절될 수
있습니다. 그것도 맞는 동작이니 그대로 적어 주세요.

**로그인 정보나 Astera 자체 파일이 든 폴더가 작업 폴더 안의 링크를 거쳐 있고 세션이 그 링크를 바꿀 수 있어서, sandbox가 그 폴더를 지킬 수 없어 sandbox로 시작할 수 없습니다. 프로젝트 폴더에서 시작해 주세요. 어느 링크인지는 Astera 로그에 있습니다.** (A folder that holds logins or Astera's own files is reached through a link inside the work folder, which the session could change, so the sandbox cannot keep it protected and the session cannot start in the sandbox. Start it in a project folder. Astera's log names the link.)

- [x] 통과 (경고가 뜨고 쓰기가 막힘)
- [ ] 통과 (링크 때문에 시작이 거절됨)
- [ ] 실패

메모:

경고 줄이 떴고, 닫은 뒤 다른 탭(6b)에 갔다 와도 다시 나타나지 않았습니다. Claude 가 홈 폴더를 믿을지 물어 믿는다고
답했고, `~/.claude.json` 의 홈 폴더 `hasTrustDialogAccepted` 는 세션 전후 모두 false 였습니다. 프로필 폴더 쓰기는 권한
규칙이 실행 전에 거절했습니다.

출력:

```text
PWD=/Users/<이름>
Permission to use Bash with command echo x > "$HOME/Library/Application Support/astera-dev/mac-check-write.txt"; echo "exit=$?" has been denied.
      64
exit=0
```

## 8. sandbox 밖의 Claude (비교용)

누가: 에이전트도

약 3분. 세션: 프로필 `mac-check-plain`, **터미널** (Terminal), 폴더 `~/astera-mac-check-<날짜>/work/mac-check-repo`.

점검 2와 같은 명령을 sandbox 없이 돌립니다. 여기서는 되어야, 점검 2의 거절이 sandbox 때문이었다고 말할 수 있습니다.
키 파일과 폴더는 크기와 종료 코드만 보고 내용은 출력하지 않습니다. 점검 2처럼 Claude 가 Opus 4.8 로 바꿀지 물으면 같은
방법으로 답합니다.

```text
Astera mac-check 8번입니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하고, 실패해도 다시 시도하거나 다른 방법을 찾지 마세요. 명령을 고치거나 덧붙이지 마세요. 끝나면 각 명령의 출력을 그대로 보여 주세요.

for p in ~/.ssh ~/.aws ~/.config/gh ~/.config/gcloud ~/.docker ~/.kube ~/.npmrc ~/.git-credentials ~/Library/Keychains; do ls "$p" > /dev/null; echo "$p exit=$?"; done
security list-keychains; echo "exit=$?"
security find-generic-password -s astera-mac-check-none > /dev/null; echo "exit=$?"
echo x > "$HOME/Library/Application Support/astera-dev/mac-check-write.txt"; echo "exit=$?"
rm -f "$HOME/Library/Application Support/astera-dev/mac-check-write.txt"
wc -c < "$HOME/Library/Application Support/astera-dev/host/host.key"; echo "exit=$?"
wc -c < "$HOME/Library/Application Support/astera-dev/host/app.key"; echo "exit=$?"
```

통과: 탭에 방패 아이콘이 없습니다. 자동 점검 결과에서 '있음' 이었던 것과 `~/Library/Keychains` 는 `exit=0` 입니다.
`security find-generic-password` 는 `The specified item could not be found in the keychain.` 과 `exit=44` 입니다.
프로필 폴더 쓰기는 `exit=0` 이고(바로 다음 줄이 그 파일을 지웁니다), `host.key` 와 `app.key` 는 둘 다 `64` 입니다.

- [x] 통과
- [ ] 실패

메모:

이번에는 `mac-check-plain` 의 Claude 세션으로 했습니다(점검 2 처럼 멈춤 없음). 방패가 없고 `sandboxed` 값도 없습니다.
쓰기 파일은 다음 줄이 지웠습니다.

출력:

```text
~/.ssh exit=0
~/.aws exit=0
~/.config/gh exit=0
ls: ~/.config/gcloud: No such file or directory
~/.config/gcloud exit=1
ls: ~/.docker: No such file or directory
~/.docker exit=1
~/.kube exit=0
ls: ~/.npmrc: No such file or directory
~/.npmrc exit=1
ls: ~/.git-credentials: No such file or directory
~/.git-credentials exit=1
~/Library/Keychains exit=0
    "~/Library/Keychains/login.keychain-db"
    "/Library/Keychains/System.keychain"
exit=0
security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.
exit=44
exit=0
      64
exit=0
      64
exit=0
```

이 세션은 점검 9에서 다시 쓰지 않으니 닫습니다.

## 9. 앱 작업 공간: 앱을 닫으면 따로 떼어 띄운 자식까지 끝나는지

누가: 에이전트도

약 5분. `run.sh` 가 작업 폴더에 넣어 둔 작은 앱(`mac-check-app/start.sh`)을 씁니다. 이 앱은 저장소의
`src/host/workspace/fixtures/app/main.cjs` 를 Electron 으로 띄우고, 자식 프로세스 하나를 따로 떼어(detached) 띄웁니다.
개발용 Astera 가 자기 Host 를 띄우는 방식과 같습니다.

이 점검은 sandbox 밖의 프로필(`mac-check-plain`)로 합니다. 작업 공간의 앱은 Host 가 sandbox 밖에서 띄우므로, sandbox
점검과 섞지 않습니다.

1. **설정** (Settings) 의 **에이전트** (Agents) 에서 **에이전트 앱 작업 공간** (Agent app workspace) 을 켭니다. 기본은
   꺼져 있습니다. 켜면 `astera-app` 스킬이 등록된 계정들에 설치되고, 새로 여는 세션부터 씁니다.
2. 새 세션을 엽니다: 프로필 `mac-check-plain`, **터미널** (Terminal), 폴더
   `~/astera-mac-check-<날짜>/work/mac-check-repo`.
3. 다음 글을 붙여 넣습니다.

   ```text
   Astera mac-check 9번입니다. 아래 명령 한 줄만 그대로 한 번 실행하고 출력을 그대로 보여 주세요. 실패해도 다시 시도하지 마세요.

   astera app js --file mac-check-app/launch.js
   ```

4. 출력에 `pid` 와 `port` 가 든 줄, 그리고 `Astera workspace fixture` 가 나옵니다. 탭 줄에 **앱** (App) 표시가 붙은 탭이
   생기고, 앱 화면의 그림이 보랏빛 테두리 안에 보입니다.
5. 터미널에서 앱과 자식이 떠 있는지 봅니다.

   ```sh
   ps -Ao pid,command | grep -E '[f]ixture-(of|profile)'
   ```

   `--fixture-of=` 가 든 줄(따로 떼어 띄운 자식)과 `fixture-profile` 이 든 줄(앱)이 보여야 합니다.
6. 세션에 다음 글을 붙여 넣습니다.

   ```text
   Astera mac-check 9번(닫기)입니다. 아래 명령 한 줄만 그대로 한 번 실행하고 출력을 그대로 보여 주세요.

   astera app js --file mac-check-app/close.js
   ```

7. 출력에 `closed` 가 나오면, 터미널에서 다시 봅니다.

   ```sh
   ps -Ao pid,command | grep -E '[f]ixture-(of|profile)'; echo "---"; ps -p "$(cat "$R/work/fixture-child.pid")"
   ```

통과: 5단계에서는 두 종류의 줄이 보였고, 7단계에서는 `---` 위에 아무 줄도 없고, `ps -p` 는 머리줄(`PID TTY ...`)만
보여 줍니다. 자식 프로세스까지 끝났다는 뜻입니다.

- [x] 통과
- [ ] 실패

메모:

**에이전트 앱 작업 공간** 은 1회차부터 켜져 있었습니다. **앱** 표시 탭과 보랏빛 테두리 안의 그림을 봤습니다. Claude 는 두 번
모두 `cd <작업 폴더> && astera app js …` 처럼 `cd` 를 앞에 붙여 돌렸습니다(sandbox 밖의 세션이라 결과에는 영향 없음).

출력:

```text
{"ok":true,"data":{"log":["{\"pid\":48588,\"port\":58143}","Astera workspace fixture"]}}
--- 5단계
48595 …/Electron.app/Contents/MacOS/Electron … --user-data-dir=~/astera-mac-check-2026-11-02/work/fixture-profile …
48621 …/Electron.app/Contents/MacOS/Electron -e setInterval(() => {}, 1000) -- --fixture-of=~/astera-mac-check-2026-11-02/work/fixture-profile
(Electron Helper 세 줄, 모두 --user-data-dir=…/fixture-profile)
--- 닫기
{"ok":true,"data":{"log":["closed"]}}
--- 7단계
---
  PID TTY           TIME CMD
```

다 보면 이 세션을 닫습니다. **에이전트 앱 작업 공간** (Agent app workspace) 은 점검 22 에서 다시 쓰니 켜 둡니다.

## 10. 같은 폴더의 Codex 터미널 탭 두 개

누가: 에이전트도

약 4분. Codex 의 대화 기록 파일이 어느 탭의 것인지 Astera 가 `lsof` 로 가려, 한 탭의 사용량이 다른 탭에 보이지 않아야
합니다.

1. 세션 A 를 엽니다: 프로필 `mac-check-codex`, **터미널** (Terminal), 폴더
   `~/astera-mac-check-<날짜>/work/mac-check-repo`.
2. A 가 다 뜨면 같은 설정으로 세션 B 를 하나 더 엽니다.
3. B 에는 아무것도 치지 않습니다. A 에만 다음 글을 보냅니다.

   ```text
   pong 이라는 한 단어로만 답하세요. 명령은 실행하지 마세요.
   ```

4. A 가 답하면 1분쯤 기다린 뒤, A 탭과 B 탭을 번갈아 눌러 창 맨 아래 상태 표시줄을 봅니다. 사용량 칸은 `Context`,
   **5시간 사용량** (5h usage), **주간 사용량** (Weekly usage) 입니다.
5. 터미널에서 Astera 가 남은 파일을 남의 것으로 보고 건너뛴 기록이 있는지 봅니다. 없어도 실패는 아닙니다.

   ```sh
   grep -h "codex rollout skipped" "$HOME/Library/Application Support/astera-dev/"*.log "$HOME/Library/Application Support/astera-dev/host/host.log" 2>/dev/null | tail -n 5
   ```

통과: A 탭의 사용량 칸에는 숫자가 나옵니다. B 탭은 세 칸 모두 비어 있고(`–`), 몇 번을 오가도 A 의 숫자가 B 에 나타나지
않습니다.

- [x] 통과
- [ ] 실패

메모:

A 에만 `pong` 을 보내고 1분 넘게 지난 뒤 A 와 B 를 세 번 오갔습니다. 5단계의 로그 줄도 나왔습니다.

출력:

```text
A: Context 1%  5시간 사용량 23% (3h 35m)  주간 사용량 59% (2d 6h)
B: Context –   5시간 사용량 –            주간 사용량 –
(세 번 오가도 같음)
--- 5단계
2026-11-02T01:16:41.282Z codex rollout skipped for session=bfdc7f94-…: ~/.codex-accounts/<계정>/sessions/2026/11/02/rollout-2026-11-02T10-16-06-…
```

다 보면 두 세션을 닫습니다.

## 11. (있는 사람만) 링크로 된 `~/.config`

누가: 에이전트도

약 3분. 자동 점검 결과의 2절에 `~/.config: 링크 -> …` 가 없으면 건너뛰고 아래의 '해당 없음' 에 표시합니다.

`~/.config` 가 다른 곳을 가리키는 링크여도, 프로젝트 폴더에서 연 sandbox 세션은 그 링크를 바꿀 수 없으므로 정상으로
시작하고 일해야 합니다.

1. 세션: 프로필 `mac-check`, **터미널** (Terminal), 폴더 `~/astera-mac-check-<날짜>/work/mac-check-repo`.
2. 세션: 프로필 `mac-check-codex`, **터미널** (Terminal), 같은 폴더.
3. 두 세션에 각각 붙여 넣습니다.

   ```text
   Astera mac-check 11번입니다. 아래 명령을 한 줄씩 한 번만 그대로 실행하고, 실패해도 다시 시도하거나 다른 방법을 찾지 마세요. 각 명령의 출력을 그대로 보여 주세요.

   echo link-ok > mac-check-11.txt && cat mac-check-11.txt
   ls ~/.config/gh > /dev/null; echo "exit=$?"
   ```

통과: 두 세션 모두 거절 없이 시작했고 방패 아이콘이 있습니다. `link-ok` 가 나옵니다. `~/.config/gh` 는 있으면
`Operation not permitted` 와 `exit=1`, 없으면 `No such file or directory` 입니다.

- [ ] 통과
- [ ] 실패
- [x] 해당 없음 (`~/.config` 가 링크가 아님)

메모:

자동 점검 결과의 2절에 링크인 폴더가 없습니다.

출력:

```text
```

다 보면 두 세션을 닫습니다.

## 12. MCP & Skills: 모든 계정이 쓰는 MCP 서버와 스킬

누가: 에이전트도

약 12분. v1.4.16 에 나온 **MCP & Skills** 를 Mac 에서 처음 봅니다. MCP 서버와 스킬을 Claude 계정 하나에 넣은 뒤
Astera 에 등록하면, Astera 가 스킬을 다른 계정에도 복사하고, MCP 서버는 Host 의 Gateway 에서 돌려 모든 세션이 그
주소로 씁니다.

- MCP 서버는 저장소의 테스트용 서버 `src/host/gateway/__fixtures__/echoServer.cjs` 를 씁니다. 받은 글 앞에 `echo: `
  를 붙여 돌려주는 작은 프로그램이고, 아무것도 내려받지 않습니다. 시작할 때 자기 pid 를 `$R/work/mac-check-echo.pid`
  에 적습니다.
- 스킬은 `run.sh` 가 만든 `$R/work/ext/mac-check-skill` 입니다. `/mac-check-skill` 을 치면 `mac-check-skill-ok` 한 줄로
  답하라는 내용뿐입니다.

1. **설정** (Settings) 의 **MCP & Skills** 에서 **등록** (Add) 을 누릅니다. **어느 계정에서 등록할까요?** (Add from which account?) 아래에
   Claude 계정 하나와 Codex 계정 하나가 보입니다. 종류마다 로그인된 계정 가운데 가장 먼저 등록한 것입니다. 보통은 준비
   3 에서 등록한 Claude 계정이고, 그 폴더가 `~/.claude` 이면 2단계의 A, 가져오기로 등록한 계정 폴더이면 B 를 씁니다.
   Esc 로 메뉴를 닫습니다.
2. 터미널(준비 1 의 변수가 있는 창)에서 그 계정에 서버와 스킬을 넣습니다. `claude mcp add` 는 그 계정의 설정 파일에
   서버 한 줄을 적을 뿐, 모델을 부르지 않습니다.

   A. 계정이 `~/.claude` 일 때:

   ```sh
   claude mcp add --scope user mac-check-echo -- "$(command -v node)" "$REPO/src/host/gateway/__fixtures__/echoServer.cjs" "$R/work/mac-check-echo.pid"
   mkdir -p ~/.claude/skills && cp -R "$R/work/ext/mac-check-skill" ~/.claude/skills/
   ```

   B. 가져온 계정 폴더일 때(첫 줄의 `<이름>` 을 그 폴더 이름으로 바꿉니다):

   ```sh
   C=~/.claude-accounts/<이름>
   CLAUDE_CONFIG_DIR="$C" claude mcp add --scope user mac-check-echo -- "$(command -v node)" "$REPO/src/host/gateway/__fixtures__/echoServer.cjs" "$R/work/mac-check-echo.pid"
   mkdir -p "$C/skills" && cp -R "$R/work/ext/mac-check-skill" "$C/skills/"
   ```

3. 앱에서 다시 **등록** (Add) 을 누르고 그 Claude 계정을 고릅니다. **<계정>에서 등록** (Add from <계정>) 창에서
   `mac-check-echo` 와 `mac-check-skill` 만 체크하고 **등록** (Add) 을 누릅니다.
4. 목록의 **MCP 서버** (MCP servers) 아래에 `mac-check-echo`, **스킬** (Skills) 아래에 `mac-check-skill` 이 보입니다.
5. 터미널에서 스킬의 사본을 봅니다. Codex 계정이 `~/.codex` 가 아니라 가져온 폴더이면 첫 줄의 `~/.codex` 를 그 폴더로
   바꿉니다.

   ```sh
   ls ~/.codex/skills/mac-check-skill "$HOME/Library/Application Support/astera-dev/extensions/skills/mac-check-skill"
   "$R/dev-astera" ext list
   ```

6. 서버를 가져온 Claude 계정의 설정에서 서버를 뺍니다(2단계가 B 였으면 앞에 `CLAUDE_CONFIG_DIR="$C"` 를 붙입니다).
   계정의 설정에 같은 이름의 서버가 남아 있으면, 그 계정의 세션은 공유한 서버 대신 자기 것을 씁니다.

   ```sh
   claude mcp remove --scope user mac-check-echo
   ```

7. 세션 12a 를 엽니다: 프로필 `mac-check-plain`, **터미널** (Terminal), 폴더
   `~/astera-mac-check-<날짜>/work/mac-check-repo`. 뜨면 `/mcp` 를 치고 Enter 를 누릅니다. 목록에 `mac-check-echo` 가
   연결된(connected) 상태로 있는지 보고 Esc 로 닫습니다. 그다음 아래 글을 붙여 넣습니다. MCP 도구를 써도 되냐고
   물으면 한 번 허락합니다.

   ```text
   Astera mac-check 12a번입니다. mac-check-echo MCP 서버의 echo 도구를, text 를 claude-gateway-ok 로 해서 딱 한 번 호출하고 받은 결과를 그대로 보여 주세요. 다른 도구나 명령은 쓰지 마세요.
   ```

8. 세션 12b 를 엽니다: 프로필 `mac-check-codex`, **터미널** (Terminal), 같은 폴더. `/mcp` 를 쳐서 목록에
   `mac-check-echo` 가 있는지 봅니다. 주소가 나오면 `http://127.0.0.1:<번호>/mcp/mcp-mac-check-echo` 입니다. 그다음
   붙여 넣습니다.

   ```text
   Astera mac-check 12b번입니다. mac-check-echo MCP 서버의 echo 도구를, text 를 codex-gateway-ok 로 해서 딱 한 번 호출하고 받은 결과를 그대로 보여 주세요. 다른 도구나 명령은 쓰지 마세요.
   ```

9. 터미널에서 서버를 띄운 것이 개발용 Host 인지 봅니다.

   ```sh
   tail -n 3 "$R/work/mac-check-echo.pid"
   ps -o pid=,ppid=,command= -p "$(tail -n 1 "$R/work/mac-check-echo.pid")"
   ps -Ao pid,command | grep '[n]ode_modules/electron/dist/Electron.app' | grep 'host.js'
   ```

통과:

- 4단계에 두 항목이 보입니다.
- 5단계의 두 폴더에 `SKILL.md` 가 있습니다(Astera 가 둔 사본과 Astera 자신의 사본). `ext list` 의 `copies` 에는
  계정마다 `"destination"` 이 `…/skills/mac-check-skill` 인 항목이 있고, 스킬을 가져온 Claude 계정의 것은
  `"adopted":true` 입니다(이미 있던 같은 사본을 Astera 가 맡았다는 뜻).
- 12a 와 12b 의 `/mcp` 에 `mac-check-echo` 가 있고, 도구 호출의 결과가 각각 `echo: claude-gateway-ok`,
  `echo: codex-gateway-ok` 입니다.
- 9단계 둘째 줄의 두 번째 수(부모 pid)가 셋째 줄 맨 앞의 수(개발용 Host 의 pid)와 같습니다. Claude 나 Codex 가 아니라
  Host 의 Gateway 가 서버를 띄웠다는 뜻입니다. 같은 폴더의 두 세션은 서버 하나를 나눠 쓰므로 pid 파일의 줄은 보통
  하나뿐입니다(몇 줄인지 적어 주세요).

- [ ] 통과
- [x] 실패

메모:

등록 메뉴의 계정은 Claude(`~/.claude`)와 Codex(가져온 폴더)여서 2단계는 A 로 했습니다. 등록 창에는 `mac-check-echo`,
`mac-check-skill` 말고 원래 있던 스킬 `synced` 도 보여서 그것은 체크하지 않았습니다. 4단계, 5단계, 12a, 9단계는 기대대로입니다.

**12b 가 실패했습니다.** sandbox 안의 Codex 세션(`mac-check-codex`)의 `/mcp` 에는 `mac-check-echo: connected (7 tools)` 가
있지만, 도구 호출이 `MCP tool call requires approval, but approval policy is never` 로 막혔습니다. 첫 시도는 모델이
`echo` 대신 `changed` 를 골랐고, 진단으로 정확히 `echo` 를 한 번 더 시켜도 같은 오류였습니다(점검표의 "딱 한 번" 을 넘어
한 번 더 시킴). Astera 는 sandbox Codex 를 승인 정책 `never` 로 띄우는데, Codex 0.165 는 이 MCP 도구 호출에 승인을 요구하고
`never` 라서 거절합니다. 그래서 sandbox Codex 세션은 공유한 MCP 서버를 쓸 수 없습니다.

12b 의 `/mcp` 는 주소를 보여 주지 않았습니다(`/mcp verbose` 에만 나옴). pid 파일은 한 줄입니다. Claude Code 는 이 점검
도중 2.1.316 으로 올라갔습니다(12a 의 첫 화면).

**이후(점검 뒤 고침, `711020bf`):** 같은 sandbox 인자로 `codex exec` 를 돌려 재현했습니다. bypass 모드에서는 같은 호출이
승인 없이 통과합니다. 이제 sandbox Codex 세션과 대화는 Astera 가 넘기는 공유 서버마다
`default_tools_approval_mode='approve'` 를 받고(Codex 0.160 부터 있는 키, 조직 정책이 더 엄격하면 그쪽을 따름), 같은
탐침이 `ECHO:hi` 로 끝났습니다.

출력:

```text
--- 4단계
MCP 서버 ▸ mac-check-echo
스킬 ▸ mac-check-skill
--- 5단계
~/.codex-accounts/<계정>/skills/mac-check-skill:
SKILL.md
~/Library/Application Support/astera-dev/extensions/skills/mac-check-skill:
SKILL.md
"copies":[{"id":"skill-mac-check-skill","accountId":"d9e2c6f6-…","destination":"~/.codex-accounts/<계정>/skills/mac-check-skill","adopted":false},{"id":"skill-mac-check-skill","accountId":"fc024cc0-…","destination":"~/.claude/skills/mac-check-skill","adopted":true}]
--- 12a /mcp
Built-in MCPs (always available)
✔ mac-check-echo                 7 tools
--- 12a
echo: claude-gateway-ok
--- 12b /mcp
• mac-check-echo: connected (7 tools)
--- 12b
• Failed mac-check-echo.changed
  └ Error: MCP tool call requires approval, but approval policy is never
(진단으로 한 번 더) • Failed mac-check-echo.echo
  └ Error: MCP tool call requires approval, but approval policy is never
--- 9단계
53246
53246 30171 /usr/local/bin/node ~/Astera/src/host/gateway/__fixtures__/echoServer.cjs ~/astera-mac-check-2026-11-02/work/mac-check-echo.pid
30171 ~/Astera/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ~/Astera/out/main/host.js
```

다 보면 두 세션을 닫습니다. 등록한 서버와 스킬은 점검 19 끝에서 지웁니다.

## 13. 에이전트 프로필: MCP 서버 빼기

누가: 에이전트도

약 5분. 프로필에서 뺀 MCP 서버는 그 프로필로 새로 연 세션에 오지 않아야 합니다.

1. **설정** (Settings) › **에이전트 프로필** (Agent profiles) 에서 **새 프로필** (New profile) 을 누르고 다음처럼 채운 뒤
   **만들기** (Create) 를 누릅니다.
   - **이름** (Name): `mac-check-nomcp`
   - **계정 추가** (Add account): 준비 3 의 Claude 계정
   - **MCP 서버** (MCP servers): `mac-check-echo` 의 체크를 끕니다.
   - **Sandbox에서 실행** (Run in the sandbox): 끕니다.
2. 터미널에서 프로필을 봅니다.

   ```sh
   "$R/dev-astera" agent-profiles show --id mac-check-nomcp
   ```

3. 세션을 엽니다: 프로필 `mac-check-nomcp`, **터미널** (Terminal), 폴더
   `~/astera-mac-check-<날짜>/work/mac-check-repo`. 뜨면 `/mcp` 를 칩니다.

통과: 2단계의 출력에 `"mcpExclude":["mcp-mac-check-echo"]` 가 있습니다. 3단계의 `/mcp` 목록에 `mac-check-echo` 가
없습니다(점검 12a 에는 있었습니다).

- [x] 통과
- [ ] 실패

메모:

프로필 편집 칸의 **MCP 서버** 에 `mac-check-echo` 체크박스가 켜진 채로 나와서 끄고 만들었습니다. 이 프로필의 세션(sandbox
밖, 방패 없음)의 `/mcp` 에는 `mac-check-echo` 가 없었습니다.

출력:

```text
{"ok":true,"data":{"id":"ap_8e5aef35e6a5","name":"mac-check-nomcp",…,"mcpExclude":["mcp-mac-check-echo"],"permission":"inherit","sandbox":false,…}}
--- 3단계 /mcp
Manage MCP servers
2 servers
  claude.ai
  ✔ claude.ai Claude Docs          8 tools
  Built-in MCPs (always available)
  ✔ plugin:playwright:playwright   25 tools
```

다 보면 이 세션을 닫습니다.

### 13b. (있는 사람만) 계정 넘기기

이 Mac 에 로그인된 Claude 계정이 둘 이상 있을 때만 합니다. 없으면 아래의 '해당 없음' 에 표시합니다. 계정 넘기기는 한도에
닿아야 일어나므로 손으로 일으킬 수 없고, 개발용 앱에만 있는 강제 장치를 씁니다. 넘어간 세션은 두 번째 계정으로 이어서
일하므로 그 계정의 토큰을 조금 씁니다. 에이전트는 DevTools 대신 앱 화면(페이지)에서 같은 줄을 부릅니다.

1. 두 번째 계정을 준비 3 의 5단계처럼 **가져오기** (Import) 로 등록합니다(새 로그인 없음).
2. 새 프로필: **이름** (Name) `mac-check-roll`, **계정 추가** (Add account) 로 Claude 계정 둘(준비 3 의 것이 먼저),
   **MCP 서버** (MCP servers) 에서 `mac-check-echo` 체크 끔, **Sandbox에서 실행** (Run in the sandbox) 끔. **만들기** (Create).
3. 세션을 엽니다: 프로필 `mac-check-roll`, **터미널** (Terminal), 같은 폴더. 계정 칸에 두 계정이 차례로 들어갑니다.
4. 터미널에서 그 세션의 id 를 찾습니다. 첫 출력의 `"id"` 가 프로필의 id 이고, 둘째 출력에서 `"agentProfileId"` 가 그
   id 인 세션의 `"id"` 가 세션의 id 입니다.

   ```sh
   "$R/dev-astera" agent-profiles show --id mac-check-roll
   "$R/dev-astera" sessions list --status alive
   ```

5. 앱 창을 누르고 Cmd+Shift+I 로 DevTools 를 엽니다(개발용 앱에만 있습니다). Console 에 다음 줄을 붙여 넣고 Enter 를
   누릅니다. `<세션 id>` 는 4단계의 세션 id 로 바꿉니다.

   ```js
   await window.api.rolling.forceRoll('<세션 id>')
   ```

6. 30초쯤 뒤 4단계의 둘째 명령을 다시 치고, 넘어간 탭에서 `/mcp` 를 칩니다. DevTools 는 Cmd+Shift+I 로 닫습니다.

통과: 5단계가 `true` 를 돌려줍니다. 6단계의 세션 목록에 같은 `"agentProfileId"` 의 세션이 두 번째 계정의
`"accountId"` 로 살아 있습니다. 넘어간 세션의 `/mcp` 에도 `mac-check-echo` 가 없습니다.

- [ ] 통과
- [ ] 실패
- [x] 해당 없음 (로그인된 Claude 계정이 하나)

메모:

설치된 Astera 에 두 번째 Claude 계정 폴더(`~/.claude-accounts/<계정2>`)가 있지만, 그 안에는 `settings.json` 과 `skills` 만
있고 로그인 상태를 담는 `.claude.json` 이 없습니다. 로그인된 두 번째 계정으로 볼 수 없어 하지 않았습니다.

다 보면 이 세션을 닫습니다.

## 14. Observe: 도구 호출 기록

누가: 에이전트도

약 6분. **Observe** 를 켜면 그 뒤에 시작한 세션의 도구 호출이 **Audit Logs** 에 남아야 합니다. Claude 는 모든 도구
호출이, Codex 는 지금 알려 주는 만큼(셸 명령과 파일 쓰기; 파일 읽기는 셸 명령의 글자로만) 남습니다. 막는 것은
없습니다.

1. **설정** (Settings) › **Security & Access** 의 **Policies** 에서 **에이전트의 도구 호출 기록** (Record agent tool calls) 을
   **Observe** 로 바꿉니다.
2. 세션 14a 를 엽니다: 프로필 `mac-check-plain`, **터미널** (Terminal), 폴더
   `~/astera-mac-check-<날짜>/work/mac-check-repo`. 붙여 넣습니다.

   ```text
   Astera mac-check 14번입니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하고 각 명령의 출력을 그대로 보여 주세요.

   echo observe-ok > mac-check-14.txt
   cat mac-check-14.txt
   git status --short
   ```

3. 세션 14b 를 엽니다: 프로필 `mac-check-codex`, **터미널** (Terminal), 같은 폴더. 같은 글을 붙여 넣습니다.
4. 1분쯤 뒤 **Audit Logs** 에서 **보기** (View) 는 **도구 호출** (Tool calls), **기간** (Period) 은 **오늘** (Today) 로 둡니다.

통과: 두 세션의 줄이 모두 있습니다. **세션** (Session) 칸에 두 세션이, **동작** (Action) 칸에 `명령 실행`, `파일 쓰기`,
`파일 읽기`, `git 에서 읽기` 같은 말이, **판단** (Decision) 칸에 `허용` 이 나옵니다. **대상** (Target) 칸에는
`mac-check-14.txt` 같은 짧은 대상만 나오고, 명령 전체나 파일 내용은 나오지 않습니다. Codex 세션의 줄은 Claude 보다
적을 수 있습니다. 세션마다 몇 줄인지 메모에 적어 주세요.

- [x] 통과
- [ ] 실패

메모:

세션마다 3줄: 14a(Claude, `mac-check-plain`) 3줄, 14b(Codex, `mac-check-codex`) 3줄. 동작은 `파일 쓰기`, `파일 읽기`,
`git 에서 읽기`, 대상은 `mac-check-14.txt` 와 `git status`, 판단은 모두 `허용`(맞는 Rule 없음). 명령 전체나 파일 내용은
나오지 않았습니다.

화면에서 본 것: Observe 로 바꾸려고 연 설정 창을 닫았다가 다시 열어도 Audit Logs 는 "이 기간에 기록된 호출이 없습니다"
(최근 7일, 허용 0) 그대로였습니다. 그때 앱의 `audit.list` 는 이미 6건을 돌려주고 있었습니다. **기간** 을 **오늘** 로 바꾸자
줄이 나왔고, 그 뒤에는 최근 7일에서도 나왔습니다. 창을 다시 열 때 목록을 새로 읽지 않는 것으로 보입니다(점검표대로
기간을 바꾸면 보임).

**이후(바로잡음):** 앱 문제가 아니었습니다. 그때 에이전트가 설정 창을 닫으려고 누른 버튼이 실제로는 창을 닫지 못해,
"다시 연" 적이 없었습니다. 개발용 앱에서 다시 보니, 설정 창을 닫았다 열면 Audit Logs 가 새로 만들어지고 새로 읽힙니다. 창이
열려 있는 동안 들어온 기록은 기간이나 필터를 바꿀 때 읽힙니다.

```text
허용 6  거부 대상 0  알 수 없음 0
10:24:52  mac-check-repo / mac-check-codex  git 에서 읽기  git status        허용  맞는 Rule 없음
10:24:… mac-check-repo / mac-check-codex  파일 읽기      mac-check-14.txt  허용  맞는 Rule 없음
10:24:… mac-check-repo / mac-check-codex  파일 쓰기      mac-check-14.txt  허용  맞는 Rule 없음
10:24:32  mac-check-repo / mac-check-plain  git 에서 읽기  git status        허용  맞는 Rule 없음
10:24:30  mac-check-repo / mac-check-plain  파일 읽기      mac-check-14.txt  허용  맞는 Rule 없음
10:24:28  mac-check-repo / mac-check-plain  파일 쓰기      mac-check-14.txt  허용  맞는 Rule 없음
```

다 보면 두 세션을 닫습니다. **Observe** 는 점검 19 까지 켜 둡니다.

## 15. Enforce: Rule 이 막는 것과 설정 폴더

누가: 에이전트도

약 8분. **Enforce** 에서는 Rule 이 거부하는 호출이 실행되기 전에 막혀야 하고, 어느 세션도 Astera 의 설정 폴더
(`astera-dev`)에 있는 Rules 파일(`audit-policy.json`)을 쓸 수 없어야 합니다. 막히는지만 봅니다. 막힌 것을 돌아가려는
시도는 하지 않습니다.

1. **Policies** 의 **Rules** 맨 아래, 새 Rule 을 만드는 칸 셋을 **거부** (Deny), **파일 삭제** (delete a file),
   **어디서나** (Anywhere) 로 두고 **Rule 추가** (Add rule) 를 누릅니다. 목록 맨 끝에 그 Rule 이 생깁니다.
2. **에이전트의 도구 호출 기록** (Record agent tool calls) 을 **Enforce** 로 바꿉니다. **Enforce 를 켤까요?** (Turn on Enforce?) 창이
   지난 7일 동안 막혔을 호출 수를 보여 줍니다. **Enforce 켜기** (Turn on Enforce) 를 누릅니다.
3. 세션 15a 를 엽니다: 프로필 `mac-check-plain`, **터미널** (Terminal), 폴더
   `~/astera-mac-check-<날짜>/work/mac-check-repo`. 붙여 넣습니다.

   ```text
   Astera mac-check 15번입니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하세요. 막힌 명령은 다시 시도하지 말고 다른 방법도 찾지 마세요. 막히는 것이 정상입니다. 각 명령의 출력이나, 막혔다면 막힌 이유를 그대로 보여 주세요.

   echo enforce-ok > mac-check-15.txt && cat mac-check-15.txt
   rm mac-check-15.txt
   ls mac-check-15.txt
   touch "$HOME/Library/Application Support/astera-dev/audit-policy.json"; echo "exit=$?"
   ```

4. 세션 15b 를 엽니다: 프로필 `mac-check-codex`, **터미널** (Terminal), 같은 폴더. 같은 글을 붙여 넣습니다.
5. **Audit Logs** 를 **오늘** (Today) 로 봅니다.
6. 되돌립니다. **에이전트의 도구 호출 기록** (Record agent tool calls) 을 다시 **Observe** 로 바꾸고, 1단계의 Rule 줄 오른쪽
   끝의 X, **삭제** (Remove) 를 누릅니다. Enforce 로 시작한 세션은 끝날 때까지 계속 막으므로 15a 와 15b 를 닫습니다.
   Enforce 를 켠 채로 두면 처음부터 있던 Rule 이 프로젝트 밖 쓰기를 막아, 다른 점검의 임시 폴더 쓰기까지 막힙니다.

통과:

- 두 세션 모두 `enforce-ok` 가 나오고, `rm` 은 `Blocked by Astera Rules: filesystem.delete is denied.` 로 막히고,
  `ls` 가 파일이 그대로 있음을 보여 줍니다.
- `touch` 는 `Blocked by Astera: an agent session cannot write Astera's settings folder.` 로 막힙니다. 15b 는 sandbox
  안이라 sandbox 도 이 쓰기를 막지만, Astera 의 훅이 실행 전에 먼저 막으므로 이 문장이 나옵니다. Codex 의 모델이 설정
  폴더 줄을 금지된 일이라며 건너뛰면, 건너뛴 줄과 이유를 메모에 적습니다.
- Audit Logs 에서 그 호출들의 **판단** (Decision) 이 **블록됨** (Blocked) 입니다.

- [x] 통과
- [ ] 실패

메모:

Rule(거부, 파일 삭제, 어디서나)을 더하고 **Enforce** 로 바꿨습니다. **Enforce 켜기** 창이 떠서 눌렀습니다(창의 막혔을 호출
수 문장은 읽지 못했습니다). 두 세션 모두 Astera 의 훅이 실행 전에 막았고, 이번에는 Codex 도 설정 폴더 줄을 건너뛰지
않았습니다. Audit Logs 의 막힌 4건은 **블록됨**("거부: 파일 삭제", "Astera 설정 폴더 쓰기")입니다. Codex 의 `echo`·`ls` 는
`명령 실행 / shell / 알 수 없음` 으로 남았습니다. 6단계대로 Observe 로 되돌리고 Rule 을 지우고 두 세션을 닫았습니다.

출력:

```text
15a (Claude, sandbox 밖)
enforce-ok
PreToolUse:Bash hook error: Blocked by Astera Rules: filesystem.delete is denied.
mac-check-15.txt
PreToolUse:Bash hook error: Blocked by Astera: an agent session cannot write Astera's settings folder.
15b (Codex, sandbox 안)
enforce-ok
Command blocked by PreToolUse hook: Blocked by Astera Rules: filesystem.delete is denied.. Command: rm mac-check-15.txt
mac-check-15.txt
Command blocked by PreToolUse hook: Blocked by Astera: an agent session cannot write Astera's settings folder.. Command: touch "$HOME/Library/Application Support/astera-dev/audit-policy.json"; echo "exit=$?"
--- Audit Logs (오늘)
허용 8  블록됨 4
파일 삭제 rm                              블록됨  거부: 파일 삭제          (두 세션)
파일 쓰기 outside project: audit-policy.json  블록됨  Astera 설정 폴더 쓰기  (두 세션)
```

## 16. Credentials: 새 세션에서 숨기기

누가: 에이전트도

약 8분. **Credentials** 에 넣은 환경 변수와 CLI 로그인은 그 뒤에 시작한 세션에서 빠져야 합니다. Astera 는 이 Mac 의
로그인 정보를 찾아 목록에 올리지 않습니다. 목록에는 직접 넣은 항목과, 키를 저장해 둔 공유 MCP 서버만 나옵니다. 값은
어디에도 출력하지 않습니다.

sandbox 밖의 프로필(`mac-check-plain`)로 합니다. sandbox 안에서는 `~/.config/gh` 가 이미 막혀 있어, 숨긴 효과와 구별할
수 없기 때문입니다.

1. 세션 16a 를 엽니다: 프로필 `mac-check-plain`, **터미널** (Terminal), 폴더
   `~/astera-mac-check-<날짜>/work/mac-check-repo`. 붙여 넣습니다.

   ```text
   Astera mac-check 16번입니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하세요. 값을 출력하는 명령은 없습니다. astera 로 시작하는 줄은 그 줄만 따로 실행하고, 그 출력에서는 warn 으로 시작하는 줄만 보여 주세요. 나머지 명령은 출력을 그대로 보여 주세요.

   if [ -n "${MAC_CHECK_TOKEN+x}" ]; then echo "MAC_CHECK_TOKEN set"; else echo "MAC_CHECK_TOKEN unset"; fi
   gh auth status > /dev/null 2>&1; echo "gh exit=$?"
   astera credentials doctor --human
   ```

2. **Security & Access** 의 **Credentials** 맨 위 안내를 읽습니다. 키체인을 말하는 문장이 있어야 합니다: `… OS 저장소가
   모든 프로그램에 내주는 로그인(Windows 자격 증명 관리자, 키체인, git 에 저장된 로그인)은 에이전트가 여전히 쓸 수
   있습니다.`
3. **항목 추가** (Add entry) 를 누르고 다음처럼 채운 뒤 **추가** (Add) 를 누릅니다.
   - **이름** (Name): `mac-check`
   - **숨길 환경 변수** (Variables to hide): `MAC_CHECK_TOKEN`
   - **CLI 로그인** (CLI logins): `GitHub CLI (gh)` 를 체크합니다. 이 목록에서 `Google Cloud CLI`, `Docker`, `kubectl`
     옆에는 **이 OS 에서는 확인하지 않았습니다** (not checked on this OS) 가 붙어 있어야 합니다. macOS 에서 숨겨지는지
     잰 것은 gh, AWS CLI, npm 입니다.
   - **숨길 세션** (Hide in): **모든 에이전트 세션** (Every agent session) 그대로 둡니다.
4. 16a 에 같은 글을 다시 붙여 넣습니다. 이미 열려 있던 세션이라 그대로여야 합니다.
5. 세션 16b 를 엽니다: 같은 프로필, 같은 폴더. 같은 글을 붙여 넣습니다.
6. 정리: 목록의 `mac-check` 항목을 펼쳐 **삭제** (Delete) 를 누르고, 확인 창에서도 **삭제** (Delete) 를 누릅니다.

통과:

- 1단계: `MAC_CHECK_TOKEN set` 입니다. `unset` 이면 준비 2 에서 개발용 Host 가 이 변수 없이 떠 있었던 것이니, 메모에
  적고 나머지만 봅니다. gh 가 이 Mac 에 로그인되어 있으면 `gh exit=0`, 아니면 `gh exit=1` 입니다.
- doctor 의 warn 줄에 `a program running as the same user can still read your files and OS stores` 가 있습니다. macOS 의
  gh 는 로그인 토큰을 키체인에 둘 수 있고, Astera 는 gh 가 로그인을 찾는 설정 폴더만 빈 폴더로 바꿉니다. 키체인의 토큰
  자체는 지우지도 숨기지도 못하고, 2단계의 안내와 doctor 가 그렇다고 말해야 합니다.
- 3단계의 표시가 위와 같습니다.
- 4단계(16a): 여전히 `MAC_CHECK_TOKEN set` 이고, gh 줄도 1단계와 같습니다.
- 5단계(16b): `MAC_CHECK_TOKEN unset` 이고, 1단계에서 `gh exit=0` 이었다면 여기서는 `gh exit=1` 입니다.

- [x] 통과
- [ ] 실패

메모:

1단계에서 `MAC_CHECK_TOKEN set`(준비 2 에서 넣은 변수가 Host 를 거쳐 세션에 옴), 이 Mac 의 gh 는 로그인되어 있어 `gh exit=0`.
2단계의 Credentials 안내에 "OS 저장소가 모든 프로그램에 내주는 로그인(Windows 자격 증명 관리자, 키체인, git 에 저장된
로그인)은 에이전트가 여전히 쓸 수 있습니다" 가 있습니다. 3단계의 목록에서 `Google Cloud CLI`, `Docker`, `kubectl` 옆에
"이 OS 에서는 확인하지 않았습니다" 가 붙어 있었습니다. 항목을 지운 뒤 Credentials 목록은 비었습니다.

에이전트가 한 실수: 처음 채울 때 화면 요약의 너무 일반적인 selector 를 써서, gh 체크박스 대신 Policies 의 **끔** 을 눌러
기록 모드가 잠깐 꺼졌습니다(항목은 그때 추가되지 않음). 바로 **Observe** 로 되돌렸습니다. 그 사이에 연 세션은 없습니다.

출력:

```text
16a (항목을 넣기 전)
MAC_CHECK_TOKEN set
gh exit=0
warn  Hiding keeps what is listed out of the sessions Astera starts; a program running as the same user can still read your files and OS stores.
16a (항목을 넣은 뒤, 이미 열려 있던 세션)
MAC_CHECK_TOKEN set
gh exit=0
16b (항목을 넣은 뒤 새 세션)
MAC_CHECK_TOKEN unset
gh exit=1
warn  Hiding keeps what is listed out of the sessions Astera starts; a program running as the same user can still read your files and OS stores.
```

다 보면 두 세션을 닫습니다.

## 17. sandbox 안의 세션에서 에이전트 브라우저

누가: 에이전트도

약 5분. sandbox 안의 Claude 세션도 에이전트 브라우저로 이 Mac 의 페이지를 열 수 있어야 합니다. 그 탭은 사람의 미리보기
탭과 따로, 그 세션만의 빈 브라우저 저장소를 씁니다(쿠키나 로그인이 없습니다).

1. **설정** (Settings) › **에이전트** (Agents) 에서 **에이전트 브라우저** (Agent browser) 를 켭니다. 새로 여는 세션부터
   쓰고, 등록된 계정들에 `astera-browser` 스킬을 설치합니다.
2. 터미널에서 작은 페이지를 띄웁니다. `http://127.0.0.1:8765/` 가 나오면 이 창은 그대로 둡니다.

   ```sh
   node "$R/work/mac-check-repo/mac-check-app/serve.cjs"
   ```

3. 세션을 엽니다: 프로필 `mac-check`, **터미널** (Terminal), 폴더 `~/astera-mac-check-<날짜>/work/mac-check-repo`. 탭에
   방패 아이콘이 있는지 보고 붙여 넣습니다.

   ```text
   Astera mac-check 17번입니다. 아래 명령 한 줄만 그대로 한 번 실행하고 출력을 그대로 보여 주세요. 실패해도 다시 시도하지 마세요.

   astera browser js --file mac-check-app/browser.js
   ```

4. 2단계의 터미널에서 Ctrl+C 로 페이지를 끕니다.

통과: 출력이 `{"ok":true` 로 시작하고 `mac-check page` 를 담고 있습니다. 탭 줄에 **에이전트** (agent) 표시가 붙은
탭이 생기고, 그 옆에 작은 방패가 있습니다. 방패에 마우스를 올리면
**샌드박스 세션의 페이지입니다: 따로 만든 빈 브라우저 저장소를 쓰며 내 로그인은 없습니다** (Page of a sandboxed session: its own empty browser storage, none of your logins)
라고 나옵니다.

- [x] 통과
- [ ] 실패

메모:

**에이전트 브라우저** 는 1회차부터 켜져 있었습니다. 세션 탭에 방패가 있었고(`sandboxed: true`), 탭 줄에 **에이전트**
표시가 붙은 `mac-check page` 탭과 그 옆의 작은 방패가 생겼습니다. 마우스를 올려 볼 수는 없어서, 방패의 안내 문장은
코드(`WorkbenchTabs.tsx` 의 `title`, `preview.agent.sandboxed`)가 점검표의 문장과 같은 것으로 확인했습니다.

출력:

```text
{"ok":true,"data":{"log":["mac-check page"]}}
```

다 보면 이 세션을 닫습니다.

## 18. sandbox 안의 Claude 워커, 완료 검사도 sandbox 안에서

누가: 에이전트도

약 10분. sandbox 프로필의 Claude 워커가 일한 Task 는 완료 검사도 같은 sandbox 안에서 돌아야 합니다. macOS 에서는
Claude Code 의 sandbox 가 쓰는 런타임(`@anthropic-ai/sandbox-runtime`)을 Astera 가 직접 불러 검사를 그 안에서 돌립니다.
검사는 `run.sh` 가 작업 폴더의 `package.json` 에 넣어 둔 `mac-check-sandbox` 입니다. worktree 바로 바깥에 파일을 쓰려
해 보고, 쓰기가 막히면 `inside-the-sandbox` 를 출력하고 통과합니다. 쓰기가 되면 `outside-the-sandbox` 를 출력하고
실패합니다.

1. `mac-check-repo` 폴더의 세션 탭이 앞에 있는 상태에서(없으면 아무 프로필로 그 폴더의 세션을 하나 엽니다) 왼쪽
   세로 막대의 Jobs 를 누릅니다.
2. **새 작업** (New job) 을 누르고 다음처럼 채운 뒤 **만들기** (Create) 를 누릅니다.
   - **목표** (Objective): `mac-check 18`
   - **에이전트 프로필** (Agent profile): `mac-check`
   - **코디네이터 계정** (Coordinator account): Claude 계정
3. 상세 창에서 **Task 추가** (Add task) 를 누르고 다음처럼 채운 뒤 **추가** (Add) 를 누릅니다.
   - **제목** (Title): `mac-check 18`
   - **에이전트 프로필** (Agent profile): 첫 항목(Job 의 프로필을 따름) 그대로 둡니다.
   - **계정** (Account): Claude 계정
   - **지시** (Instructions): 아래 글을 통째로 붙여 넣습니다.
   - **완료 검사** (Completion checks): **고르지 않은 것** (Not picked) 에서 `+ mac-check-sandbox` 를 누릅니다.
4. 상세 창의 **실행** (Run) 을 누릅니다. 워커 탭에 방패 아이콘이 있는지 봅니다.

```text
Astera mac-check 18번(Claude 워커)입니다. 아래 명령 한 줄만 그대로 한 번 실행하고, 평소 워커처럼 astera 로 이 Task 가 끝났다고 보고하세요. 다른 파일은 만들거나 고치지 마세요.

echo worker-ok > mac-check-18.txt && git add -A && git commit -q -m "mac-check 18: sandboxed worker commit" && git log --oneline -1
```

5. 워커가 보고하면 Astera 가 검사를 돌립니다. 그 Task 의 완료 칸에서 `mac-check-sandbox` 줄을 찾아 **출력 보기** (Show output)
   를 누릅니다.
6. 터미널에서 worktree 바깥에 파일이 생기지 않았는지 봅니다.

   ```sh
   find ~/astera-worktrees -name mac-check-sandbox-outside.txt
   ```

통과: 검사가 통과하고 Task 가 **끝났다** (Done) 로 바뀝니다. 출력에 `inside-the-sandbox` 와, 쓰기를 막은
`Operation not permitted` 가 있습니다. 검사 줄에 **sandbox 밖에서 검증함** (validated outside the sandbox) 이 붙지
않습니다(그 표시는 sandbox 가 없는 Windows 의 Claude 에만 붙습니다). 6단계는 아무것도 출력하지 않습니다. 검사를 sandbox
에 넣지 못하면 Astera 는 검사를 돌리지 않고 사람에게 묻습니다(다시 시도, 이 검사 건너뛰기, 실패로 표시). 그 질문이
떴다면 문장을 그대로 메모에 옮기고 실패로 표시합니다.

- [ ] 통과
- [x] 실패

메모:

**워커의 보고가 sandbox 안에서 돌아 Host 에 닿지 못했습니다.** 워커(Claude, `mac-check` 프로필, sandbox 안)는 명령을 돌려
`eca81ff` 를 커밋한 뒤, 보고를 `printf '…' | "$ASTERA_CLI" send … --body -` 로 보냈습니다. Claude 의 sandbox 는 `astera` 로
시작하는 한 줄 명령만 밖에서 돌리므로 이 명령은 sandbox 안에서 돌았습니다. 안에서는 `TMPDIR=/tmp/claude-501` 이라 CLI 가
Host 주소를 `/tmp/claude-501/astera-host-…-v4/sock` 으로 잘못 계산했고(`HOST_NOT_RUNNING`), 대신 남기려던
`orch/pending-reports` 쓰기도 sandbox 가 막았습니다(`EPERM`). 에이전트가 "명령줄을 astera 로 시작하라" 고 한 번 말하자,
워커는 `astera help` 가 권하는 대로 `astera send … --body - … <<'BODY'` heredoc 으로 보냈지만, 여러 줄이 된 이 명령도
sandbox 안에서 돌아 똑같이 실패했습니다. 진단으로 heredoc 없는 한 줄(`astera send … --body "…"`)을 시키자 `accepted` 됐습니다.

그 뒤로는 기대대로입니다. 검사가 통과하고(`validation passed`) Task 가 끝났습니다. 검사 줄에 "sandbox 밖에서 검증함" 은
없고, 6단계의 `find` 는 아무것도 출력하지 않았습니다. 통과한 검사에는 **출력 보기** 버튼이 나오지 않아서(출력이 있을 때만
나옴), 출력은 Host 가 남긴 `validation passed` 소식에서 옮겼습니다. 상세 창의 토큰: `토큰 678,536 (입력 671,635, 출력 6,901)`,
`코디네이터 토큰 588,199 (입력 585,961, 출력 2,238)`, Task 칩 `토큰 678,536`.

에이전트 쪽 일: 워커를 기다리는 10분 남짓 앱 작업 공간에 스크립트를 보내지 않아, 작업 공간이 스스로 닫히며 개발용 앱이
꺼졌습니다(개발용 Host 와 세션은 살아 있었음). 앱을 다시 띄워 이어 했습니다.

**이후(점검 뒤 고침, `4c859a1f`):** 재 보니(Claude Code 2.1.316) `astera` 로 시작하는 줄이라도 파이프, `< 파일`,
heredoc 을 쓰면 sandbox 안에서 돕니다. 따옴표 안 여러 줄 본문과 `\` 줄 이음은 밖에서 돕니다. Claude sandbox 는
127.0.0.1 TCP 도 막아서 loopback 길도 닫혀 있습니다. 이제 CLI 는 sandbox 안(`SANDBOX_RUNTIME=1`)에서 Host 에 못 닿으면
`host start` 대신 "그 줄만으로, 글은 따옴표 안에 넣어 다시 치라" 고 답하고(`HOST_NOT_RUNNING`, 다음 단계 없음), spec 파일과
가이드는 sandbox Claude 세션에서는 본문을 따옴표 안에 주라고 말합니다.

출력:

```text
--- 워커의 첫 보고 (sandbox 안)
{"ok":false,"error":{"code":"HOST_NOT_RUNNING","message":"cannot reach the Host at /tmp/claude-501/astera-host-3a3dc6c614d0-v4/sock (unreachable) — start one with `astera host start` — and the report could not be recorded either: cannot write ~/Library/Application Support/astera-dev/orch/pending-reports: Error: EPERM: operation not permitted, mkdir '…/orch/pending-reports'",…}}
--- 한 줄로 다시 보낸 보고
{"ok":true,"data":{"value":"accepted"}}
--- 검사 출력 (validation passed 소식)
exitCode=0. The Task moved to completed.
> mac-check-repo@1.0.0 mac-check-sandbox
> if echo x > ../mac-check-sandbox-outside.txt; then echo outside-the-sandbox; exit 1; fi; echo inside-the-sandbox
sh: ../mac-check-sandbox-outside.txt: Operation not permitted
inside-the-sandbox
--- 6단계
(출력 없음)
```

## 19. Findings

누가: 에이전트도

약 10분. Phase 11 에서 들어온 **Findings** 를 Mac 에서 봅니다. 프로필 둘이 똑같으면 곧바로 찾은 것이 생기고,
**에이전트 프로필** (Agent profiles) 목록에 표시가 붙고, 개발용 `astera` 의 `agent-profiles audit` 도 같은 것을 답해야
합니다. 그리고 Claude Code 2.1.312 이상이면, Observe 가 켜진 동안 Claude 세션이 쓴 스킬과 하위 에이전트가 기록되어야
합니다.

1. **에이전트 프로필** (Agent profiles) 에서 **새 프로필** (New profile) 을 누르고, `mac-check` 와 똑같이 채워
   **만들기** (Create) 를 누릅니다.
   - **이름** (Name): `mac-check-dup`
   - **계정 추가** (Add account): `mac-check` 와 같은 Claude 계정 하나
   - **MCP 서버** (MCP servers): 모두 체크한 채로
   - **권한 확인** (Permission checks): **앱 설정 따름** (Follow the app setting)
   - **Sandbox에서 실행** (Run in the sandbox): 켭니다.
2. **Security & Access** 의 **Findings** 를 봅니다.
3. **에이전트 프로필** (Agent profiles) 목록으로 돌아가 `mac-check` 와 `mac-check-dup` 줄을 봅니다.
4. 터미널에서 개발용 `astera` 에 묻습니다.

   ```sh
   "$R/dev-astera" agent-profiles audit --human
   ```

5. 자동 점검 결과 1절에 `claude-uses` 줄이 있으면(Claude Code 가 2.1.312 보다 낮으면) 이 단계는 건너뜁니다. 새 세션을
   엽니다: 프로필 `mac-check-plain`, **터미널** (Terminal), 폴더 `~/astera-mac-check-<날짜>/work/mac-check-repo`. 뜨면
   `/mac-check-skill` 을 치고 Enter 를 누릅니다. 답이 오면 아래 글을 붙여 넣습니다.

   ```text
   Astera mac-check 19번입니다. general-purpose 서브에이전트 하나에게 pong 이라는 한 단어로만 답하게 하고, 그 답을 그대로 보여 주세요. 명령은 실행하지 마세요.
   ```

   답이 오면 터미널에서 기록을 봅니다.

   ```sh
   grep -hE '"via":"(slash|skill-tool|subagent|agent-tool)"' "$HOME/Library/Application Support/astera-dev/extension-uses/"*.jsonl | tail -n 5
   ```

6. 정리합니다. 열린 세션은 먼저 닫습니다.
   - `mac-check-dup` 을 펼쳐 **삭제** (Delete) 를 누르고 확인합니다. Findings 에서 그 항목이 사라집니다.
   - **MCP & Skills** 에서 `mac-check-echo` 와 `mac-check-skill` 을 하나씩 펼쳐 **제거** (Remove) 를 누르고, 확인 창의
     **제거** (Remove) 를 누릅니다.
   - Findings 를 다시 보면 `mac-check-nomcp` 에 대해
     **삭제된 MCP 서버를 제외 목록에 두고 있습니다: mcp-mac-check-echo.** (Leaves out an MCP server that was removed: mcp-mac-check-echo.)
     항목이 생깁니다. `mac-check-nomcp` 를 삭제하면(13b 를 했다면 `mac-check-roll` 도) 사라집니다.
   - 터미널에서 `ls ~/.codex/skills` 에 `mac-check-skill` 이 없는지 봅니다. Astera 가 둔 사본은 Astera 가 지웁니다.
     2단계에서 직접 넣은 사본은 남으므로 `rm -rf ~/.claude/skills/mac-check-skill` 로 지웁니다(점검 12 가 B 였으면
     `rm -rf "${C:?}/skills/mac-check-skill"`).

통과:

- 2단계: **다음 프로필은 계정, 제외한 MCP 서버, 권한, 샌드박스가 모두 같습니다: mac-check, mac-check-dup.** (These profiles have the same accounts, MCP exclusions, permission and sandbox: mac-check, mac-check-dup.)
  항목이 **에이전트 프로필 열기** (Open Agent profiles), **무시** (Ignore) 와 함께 보입니다. 위에는 사용 기록으로 찾는
  항목은 Observe 를 30일 켜 두어야 한다는 줄이 있습니다.
- 3단계: 두 줄에 **Findings 1** 표시가 붙어 있고, 누르면 Findings 로 갑니다.
- 4단계: `duplicate-profile` 로 시작하는 줄에 `mac-check, mac-check-dup` 이 있습니다.
- 5단계: `"name":"mac-check-skill"` 인 줄(`slash` 나 `skill-tool`)과 `"via":"subagent"` 인 줄이 있습니다. 줄에는 이름과
  세션 id 만 있고 프롬프트는 없습니다. 쓰지 않은 스킬을 알려 주는 항목(`unused-skill`)은 Observe 기록이 30일 쌓여야
  판단하므로, 오늘 켠 기록으로는 보이지 않는 것이 맞습니다. 그래서 그 대신 기록이 macOS 에서 남는지를 봅니다.
- 6단계: 지울 때마다 항목이 사라지고, MCP 서버를 지운 뒤에는 `mac-check-nomcp` 항목이 생겼다가 그 프로필을 지우면
  사라집니다. `~/.codex/skills` 에 `mac-check-skill` 이 없습니다.

- [x] 통과
- [ ] 실패

메모:

2단계의 항목은 **에이전트 프로필 열기**, **무시** 와 함께 보였고, 위에 "사용 기록으로 찾는 항목은 Observe를 30일 켜 두어야
합니다. 지금까지 0일 켜져 있었습니다." 가 있었습니다. 프로필 목록의 **Findings 1** 을 누르면 Findings 로 갑니다. 5단계는
Claude Code 2.1.316 이라 했습니다(스킬 답 `mac-check-skill-ok`, 하위 에이전트 답 `pong`). 6단계: `mac-check-dup` 을 지우자
`duplicate-profile` 이 사라졌고, MCP & Skills 에서 둘을 제거하자 `mac-check-nomcp` 의 `broken-reference` 가 생겼다가 그
프로필을 지우자 `No findings.` 가 됐습니다(화면 대신 `agent-profiles audit` 로 봄). Codex 계정 폴더의 사본은 Astera 가
지웠고, `~/.claude/skills/mac-check-skill` 은 손으로 지웠습니다. 13b 는 하지 않아 `mac-check-roll` 은 없습니다.

출력:

```text
--- 2단계 (Findings)
mac-check, mac-check-dup
다음 프로필은 계정, 제외한 MCP 서버, 권한, 샌드박스가 모두 같습니다: mac-check, mac-check-dup.
하나만 두고 나머지는 보관하세요.  [에이전트 프로필 열기] [무시]
--- 3단계
▸ mac-check  Claude 계정 1개  Findings 1
▸ mac-check-dup  Claude 계정 1개  Findings 1
--- 4단계
Usage findings need Observe on for 30 days. It has been on for 0 days.
duplicate-profile  mac-check, mac-check-dup  These profiles have the same accounts, MCP exclusions, permission and sandbox: mac-check, mac-check-dup.  → Keep one and archive the others.
--- 5단계
{"id":"eu_…","at":"2026-11-02T01:52:44.766Z","sessionId":"5eb86cad-…","provider":"claude","kind":"terminal",…,"via":"slash","name":"mac-check-skill"}
{"id":"eu_…","at":"2026-11-02T01:52:54.508Z","sessionId":"5eb86cad-…","provider":"claude","kind":"terminal",…,"via":"agent-tool","name":"general-purpose"}
{"id":"eu_…","at":"2026-11-02T01:52:54.513Z","sessionId":"5eb86cad-…","provider":"claude","kind":"terminal",…,"via":"subagent","name":"general-purpose"}
--- 6단계
broken-reference  mac-check-nomcp  Leaves out an MCP server that was removed: mcp-mac-check-echo.  → Edit the profile.
(mac-check-nomcp 삭제 뒤) No findings.
ls ~/.codex-accounts/<계정>/skills | grep mac-check-skill  → 없음
```

## 20. 탭 줄 스크롤, 트랙패드로

누가: 사람만

약 4분. 탭이 많아지면 각 탭이 이름의 절반쯤이 보일 때까지 줄어들고, 그다음부터는 탭 줄이 옆으로 스크롤되어야 합니다.
트랙패드로 확인합니다.

1. 앱 창의 오른쪽 끝을 끌어 폭을 절반쯤으로 줄입니다. 전체 화면이면 먼저 빠져나옵니다.
2. `mac-check-repo` 의 세션 탭이 앞에 있는 상태에서 왼쪽 세로 막대의 **파일 탐색기** (File explorer) 를 엽니다. 파일을
   하나씩 두 번 눌러 탭으로 엽니다: `README.md`, `package.json`, `.gitignore`, `mac-check-app` 안의 파일들,
   `node_modules/is-number` 안의 파일들. 탭이 창 폭을 넘을 때까지 엽니다.
3. 탭 줄 위에 포인터를 두고 트랙패드를 두 손가락으로 좌우로 쓸어 봅니다. 그다음 위아래로 쓸어 봅니다.

통과: 탭이 넘치기 전에는 각 탭이 이름의 절반쯤이 보일 때까지 줄어듭니다. 넘친 뒤에는 좌우로 쓸면 탭 줄이 따라
움직이고, 위아래로 쓸어도 탭 줄이 옆으로 움직입니다. 움직이는 동안 탭 줄 아래 가장자리에 얇은 막대(지금 보이는 자리)가
잠깐 나타납니다. 탭 줄 오른쪽 끝의 **+** 는 스크롤해도 그 자리에 남습니다.

- [ ] 통과
- [ ] 실패

메모:

사람만 하는 점검이라 에이전트는 하지 않았습니다(트랙패드 스크롤).

다 보면 연 파일 탭을 닫고 창 크기를 되돌립니다.

## 21. 한글 입력, 에이전트가 일하는 동안

누가: 사람만

약 8분. 터미널 탭에 macOS 의 한글 입력기로 칠 때, 앱이 바쁜 동안에도 친 글자가 한 번씩만 가야 합니다. 1회차 뒤에 고친
문제입니다. 앱이 바쁠 때 앞서 친 줄이 다시 들어가거나, 띄어쓰기가 앞 단어를 지우거나, 조합 중이던 글자가 사라졌습니다.
조합 중인 글자를 마무리하는 길 가운데 macOS 와 Linux 의 입력기만 타는 길이 있어서, Mac 에서 직접 쳐 봐야 합니다.

준비: 입력 소스에 한국어(두벌식)가 있어야 합니다. 클립보드에 `mac-check` 라는 글을 복사해 둡니다.

1. 세션을 엽니다: 프로필 `mac-check-plain`, **터미널** (Terminal), 폴더
   `~/astera-mac-check-<날짜>/work/mac-check-repo`. 아래 글을 붙여 넣고 Enter 를 누릅니다. 답이 길게 이어지는 동안
   앱이 바쁩니다.

   ```text
   Astera mac-check 21번입니다. 1부터 400까지의 숫자를 한 줄에 하나씩 써 주세요. 도구나 명령은 쓰지 마세요.
   ```

2. 답이 이어지는 동안 같은 탭의 입력칸에 한국어로 칩니다.
   1. `안녕하세요 반갑습니다` 를 보통 빠르기로 칩니다.
   2. 이어서 `가나` 를 치되, `나` 에 밑줄이 있는(조합 중인) 동안 Cmd+V 를 누릅니다.
   3. 이어서 `다` 를 치고, 밑줄이 있는 동안 다른 탭을 눌렀다가 이 탭으로 돌아옵니다.
   4. 이어서 `라` 를 치고, 밑줄이 있는 동안 Enter 를 누릅니다. Claude 가 일하는 중이라 메시지는 대기열에 들어갑니다.
3. Claude 가 답을 끝내면 대기열의 메시지가 보내집니다. 보내진 메시지를 봅니다.

통과: 입력칸의 글과 보내진 메시지가 `안녕하세요 반갑습니다가나mac-check다라` 입니다(띄어쓰기는 친 대로). 앞서 친 줄이
다시 붙거나, 띄어쓰기를 친 뒤 앞 단어가 지워지거나, 글자 하나가 사라지지 않습니다. 붙여넣기 바로 앞의 `나`, 탭을 오간
`다`, Enter 바로 앞의 `라` 가 모두 남아 있습니다. 다르게 나왔다면 나온 글을 그대로 메모에 옮깁니다.

- [ ] 통과
- [ ] 실패

메모:

사람만 하는 점검이라 에이전트는 하지 않았습니다(한글 입력기로 치기).

다 보면 이 세션을 닫습니다.

## 22. 앱 작업 공간: 답하지 않는 앱도 닫히는지

누가: 에이전트도

약 4분. 앱 작업 공간의 닫기는, 멈춰서 끝내 달라는 신호에 답하지 않는 앱도 끝내야 합니다. 점검 9 의 작은 앱을 띄운 뒤
`kill -STOP` 으로 멈춰 두고 닫아 봅니다. **에이전트 앱 작업 공간** (Agent app workspace) 이 켜져 있어야 합니다(점검 9).

1. 세션을 엽니다: 프로필 `mac-check-plain`, **터미널** (Terminal), 폴더
   `~/astera-mac-check-<날짜>/work/mac-check-repo`. 붙여 넣습니다.

   ```text
   Astera mac-check 22번입니다. 아래 명령 한 줄만 그대로 한 번 실행하고 출력을 그대로 보여 주세요. 실패해도 다시 시도하지 마세요.

   astera app js --file mac-check-app/launch.js
   ```

2. 출력에 `Astera workspace fixture` 가 나오면, 터미널에서 앱의 main 프로세스를 멈춥니다. 마지막 줄의 상태 칸이 `T` 로
   시작하면 멈춘 것입니다.

   ```sh
   P=$(pgrep -f 'fixtures/app/main.cjs' | head -n 1); echo "$P"; kill -STOP "$P"; ps -o pid=,stat= -p "$P"
   ```

3. 세션에 붙여 넣습니다.

   ```text
   Astera mac-check 22번(닫기)입니다. 아래 명령 한 줄만 그대로 한 번 실행하고 출력을 그대로 보여 주세요.

   astera app js --file mac-check-app/close.js
   ```

4. 출력에 `closed` 가 나오면 터미널에서 다시 봅니다.

   ```sh
   ps -p "$P"; echo "---"; ps -Ao pid,command | grep -E '[f]ixture-(of|profile)'
   ```

통과: 2단계의 상태가 `T` 입니다. 3단계는 몇 초 안에 `closed` 를 돌려줍니다. Astera 는 먼저 끝내 달라는 신호를 보내고,
2초 안에 끝나지 않으면 강제로 끝냅니다. 4단계의 `ps -p` 는 머리줄(`PID TTY ...`)만 보여 주고, `---` 아래에는 아무
줄도 없습니다.

- [x] 통과
- [ ] 실패

메모:

닫기는 바로 `closed` 를 돌려줬습니다(세션의 한 턴 전체가 13초, 대부분은 모델의 시간).

출력:

```text
{"ok":true,"data":{"log":["{\"pid\":84398,\"port\":59561}","Astera workspace fixture"]}}
--- 2단계
84405
84405 T
--- 닫기
{"ok":true,"data":{"log":["closed"]}}
--- 4단계
  PID TTY           TIME CMD
---
```

다 보면 이 세션을 닫습니다. **에이전트 앱 작업 공간** (Agent app workspace) 은 이제 꺼도 됩니다.

## 23. Cmd+Q 로 개발용 앱 끄기

누가: 사람만

약 4분. `npm run dev` 로 띄운 개발용 앱은 Cmd+Q 로 깨끗하게 끝나야 합니다. macOS 에서는 창을 닫아도 앱이 남고, Cmd+Q
가 앱을 끄는 길입니다. 끈 뒤에는 앱의 프로세스가 모두 사라지고, 세션이 없으면 개발용 Host 도 마지막 연결이 끊기고 1분쯤
뒤 스스로 끝나야 합니다.

1. 남은 세션 탭을 모두 닫습니다. 점검 4 와 18 의 코디네이터 탭과 워커 탭도 닫습니다. 세션은 앱을 꺼도 Host 에서 계속
   돌기 때문입니다.
2. 앱 창을 앞에 두고 Cmd+Q 를 누릅니다.
3. `npm run dev` 를 띄운 터미널이 프롬프트로 돌아오는지 봅니다.
4. 곧바로 다른 터미널에서 봅니다.

   ```sh
   ps -Ao pid,command | grep '[n]ode_modules/electron/dist/Electron.app'; echo "---"; ps -Ao pid,command | grep '[e]lectron-vite'
   ```

5. 1분쯤 기다린 뒤 4단계의 명령을 다시 칩니다.

통과: 3단계의 터미널이 5초 안에 돌아옵니다. 4단계에서 `---` 위에는 개발용 Host(`host.js` 가 든 줄) 하나만 있거나 아무
줄도 없고, `---` 아래에는 아무 줄도 없습니다. 5단계에서는 둘 다 아무 줄도 없습니다. 터미널이 돌아오지 않아 Ctrl+C 를
눌러야 했다면 실패로 표시하고 메모에 적습니다.

- [ ] 통과
- [ ] 실패

메모:

사람만 하는 점검이라 에이전트는 하지 않았습니다(Cmd+Q). 에이전트는 점검 24, 25, 30 에서 페이지의 `window.api.app.quit()`
으로 껐고, 그때마다 Host 까지 1분 남짓 안에 끝났습니다.

출력:

```text
```

## 24. inspector 를 켜고 띄운 개발용 앱 끄기

누가: 에이전트도

약 4분. 1회차에서는 main 프로세스에 inspector 를 붙인 채 끄려 하자 앱이 끝나지 않았습니다. Node 는 붙어 있는
inspector 연결이 모두 끊길 때까지 끝나지 않기 때문입니다. 지금은 에이전트의 앱 작업 공간 안내서에 그 규칙이 있습니다(끄기
전에 inspector 연결을 닫을 것). 붙어 있는 연결이 없으면 inspector 를 켜고 띄운 앱도 몇 초 안에 끝나야 합니다.

1. 저장소 폴더의 터미널에서 inspector 를 켜고 띄웁니다. `Debugger listening on ws://127.0.0.1:5858/…` 줄이 나옵니다.
   에이전트는 터미널 대신 앱 작업 공간의 `launch()` 로 같은 명령을 띄웁니다. 그래야 페이지를 CDP 로 다뤄 3단계의
   `window.api.app.quit()` 을 부를 수 있고, 끝나지 않으면 `close()` 로 끝낼 수 있습니다. macOS 의 앱 작업 공간은 창을
   숨겨 주지 않으므로 창이 사람의 화면에 뜰 수 있습니다. 디버깅 포트는 electron-vite 의 `--remoteDebuggingPort` 로
   넘깁니다. 아무도 보지 않는 페이지도 그려지게 하는 Chromium 스위치(`$ASTERA_APP_CHROMIUM_FLAGS`)는 electron-vite 가 모르는
   옵션이라 거기에 이어 쓰면 electron-vite 가 시작을 거절합니다. 그래서 두 번째 `--` 뒤에 둡니다. 그 뒤의 것을
   electron-vite 가 Electron 에 넘깁니다. 앱 작업 공간은 띄운 명령의 출력을 버리므로 출력은 결과 폴더의 파일로 보냅니다.
   에이전트가 띄우는 명령은 이렇습니다(`<결과 폴더>` 는 절대 경로로):

   ```sh
   npm run dev -- --inspect --remoteDebuggingPort $ASTERA_APP_CDP_PORT -- $ASTERA_APP_CHROMIUM_FLAGS > <결과 폴더>/inspect-dev.log 2>&1
   ```

   위의 `Debugger listening …` 줄과 통과 기준의 `Waiting for the debugger to disconnect...` 는 그 파일에서 찾습니다.
   '5초 안에 돌아옴' 은 끈 뒤 5초 안에 4단계의 `ps` 가 아무 줄도 출력하지 않는지로 봅니다. 사람은 아래 줄을 그대로
   칩니다.

   ```sh
   npm run dev -- --inspect
   ```

2. 앱이 뜨면, 에이전트는 inspector(5858 번)에 붙여 둔 연결을 모두 닫습니다. 사람은 아무것도 붙이지 않습니다.
3. 앱을 끕니다. 사람은 앱 창에서 Cmd+Q 를 누릅니다. 에이전트는 inspector 가 아니라 앱 화면(페이지)에서
   `window.api.app.quit()` 을 부릅니다. Cmd+Q 와 같은 `app.quit()` 입니다.
4. 1단계의 터미널을 보고, 다른 터미널에서 봅니다.

   ```sh
   ps -Ao pid,command | grep '[n]ode_modules/electron/dist/Electron.app' | grep -v 'host.js'
   ```

통과: 1단계의 터미널이 5초 안에 프롬프트로 돌아오고, `Waiting for the debugger to disconnect...` 줄이 없습니다. 4단계는
아무 줄도 출력하지 않습니다(개발용 Host 의 줄은 빼고 봅니다). 에이전트는 이것을 1단계의 로그 파일과, 끈 뒤 5초 안의
4단계 `ps` 로 봅니다. 끝나지 않으면 inspector 에 무엇이 붙어 있었는지 메모에 적고, 1단계의 터미널에서 Ctrl+C 를
누릅니다(에이전트는 앱 작업 공간의 `close()`).

- [x] 통과
- [ ] 실패

메모:

README 대로 앱 작업 공간의 `launch()` 로 `npm run dev -- --inspect --remoteDebuggingPort $ASTERA_APP_CDP_PORT -- $ASTERA_APP_CHROMIUM_FLAGS > $R/inspect-dev.log 2>&1`
을 띄웠습니다. 창이 화면에 뜨지 않게, 5858 번 inspector 에 잠깐씩 붙어 `app.hide()` 를 12번 부르고 그 연결은 모두 닫았습니다
(로그의 "Debugger attached / ending" 줄들이 그것입니다). 끄기 전 5858 에 붙은 연결은 0개였습니다. 앱 화면에서 CDP 로
`window.api.app.quit()` 을 부르자 Host 를 뺀 Electron 이 212 ms 만에 모두 끝났고, `npm run dev` 도 돌아왔습니다.

```text
Debugger listening on ws://127.0.0.1:5858/…
(끈 뒤) Electron (Host 제외) 212 ms 안에 0개
grep -c "Waiting for the debugger to disconnect" inspect-dev.log → 0
```

## 25. 패키지한 앱

누가: 에이전트도

약 25분(빌드 몇 분 포함). 지금까지는 개발용 앱이었습니다. 이 저장소로 macOS 앱을 빌드해, 그 앱이 뜨고 sandbox 안의
Claude 세션과 워커가 일하는지 봅니다. 완료 검사를 sandbox 에 넣는 런타임은 패키지 안의 `app.asar.unpacked` 에서
불러와야 하는데, 그 길은 패키지한 앱에서만 탑니다.

빌드는 서명 없이(ad-hoc 서명) 폴더로만 만들고(dmg 없음), 결과 폴더의 `packaged/` 에 둡니다. 이름은 `AsteraMacCheck`, id
는 `io.github.parsingk.astera.maccheck` 로 바꿉니다. Electron 은 프로필 폴더의 이름을 앱 이름으로 짓기 때문에, 원래
이름(`Astera`)으로 빌드하면 설치된 Astera 의 프로필 폴더를 열 수 있습니다. 바꾼 이름이면 그럴 일이 없습니다. 띄울 때는
개발용 앱의 프로필 폴더를 쓰게 해서 준비 3, 4 의 계정과 프로필을 그대로 씁니다.

- 디스크: 빌드 결과가 약 400 MB 입니다(추정). Electron 을 내려받아 두는 곳(`~/Library/Caches/electron`)에 이 버전이
  없으면 약 100 MB 를 더 내려받습니다.
- 시간: 이 Mac 에서 빌드가 1~3분쯤 걸릴 것으로 봅니다(추정. 릴리스 CI 의 macOS 러너는 두 아키텍처를 합친 dmg 와 zip
  까지 4분 30초에 만듭니다). 실제 값을 메모에 적어 주세요.

1. 점검 23, 24 뒤로 개발용 Host 가 끝났는지 봅니다. 아무 줄도 없어야 하고, 있으면 1분 더 기다립니다. 개발용 Host 가
   살아 있으면 패키지한 앱이 그 Host 에 붙어, 패키지 안의 Host 를 시험하지 못합니다.

   ```sh
   ps -Ao pid,command | grep '[n]ode_modules/electron/dist/Electron.app'
   ```

2. 저장소 폴더의 터미널에서 빌드합니다. `time` 이 걸린 시간을, 마지막 줄이 크기를 알려 줍니다.

   ```sh
   cd "$REPO" && ./node_modules/.bin/electron-vite build
   export CSC_IDENTITY_AUTO_DISCOVERY=false; arch=$(uname -m | sed 's/x86_64/x64/')
   time ./node_modules/.bin/electron-builder --mac --dir --"$arch" --publish never -c.directories.output="$R/packaged" -c.productName=AsteraMacCheck -c.appId=io.github.parsingk.astera.maccheck -c.extraMetadata.productName=AsteraMacCheck -c.mac.notarize=false -c.mac.identity=-
   du -sh "$R/packaged"
   ```

3. 설치된 `astera` 명령을 저장해 둡니다. 패키지한 앱은 켤 때마다, Astera 가 깔아 둔 `astera` 명령
   (`~/.local/bin/astera`)이 있으면 그것이 자기를 가리키도록 다시 씁니다. 설치된 Astera 의 설정에서 CLI 탭의 버튼으로
   그 명령을 깔았다면 이 파일입니다. 이 폴더는 프로필이나 앱 이름과 상관없이 정해져 있어서, 이름을 바꿔 빌드해도 피할 수
   없습니다. 그래서 띄우기 전에 복사해 두고 9단계에서 되돌립니다. 이 파일에는 실행 파일과 CLI 스크립트(`cli.js`)의
   경로만 있고 비밀은 없습니다. MCP 클라이언트에 Astera 를 등록해 두었다면 그 등록도 이 파일을 경로로 가리키므로, 이
   파일과 함께 바뀌었다가 함께 돌아옵니다.

   ```sh
   [ -f ~/.local/bin/astera ] && head -n 2 ~/.local/bin/astera && cp -p ~/.local/bin/astera "$R/astera-cli.before"
   ```

   아무것도 나오지 않으면 그 명령을 깔지 않은 것이니 9단계는 건너뜁니다. 나왔다면 파일의 두 줄이고, 둘째 줄(설치된
   Astera 의 실행 파일과 `cli.js` 를 가리키는 줄)을 메모에 적습니다. 4단계부터 9단계까지는 보통 터미널의 `astera` 가
   패키지한 앱을 가리키므로, 그동안 보통 터미널에서는 설치된 Astera 에 `astera` 명령을 쓰지 않습니다. Astera 세션 안의
   `astera`(에이전트가 `astera app js` 로 쓰는 것)는 그 세션의 것이라 바뀌지 않으니 그대로 씁니다.
4. 앱을 띄웁니다. 이 터미널은 앱을 끌 때까지 그대로 둡니다.
   - 설치된 Astera 가 있으면 켜 둔 채로 띄웁니다. 설치된 Astera 가 자기 프로필 폴더를 잡고 있으므로, 패키지한 앱이 혹시
     그 폴더를 골랐다면 열지 못하고 곧바로 끝납니다(프로필 하나에 앱은 하나만 뜹니다).
   - 이 앱은 macOS 에게 처음 보는 앱이라, 키체인 접근을 묻는 창이 뜨면 개발용 앱 때처럼 거부를 누릅니다.
   - 패키지한 앱은 업데이트를 확인하고, 새 버전이 있으면 저절로 내려받기 시작합니다. 제목 줄에 업데이트가 보이면 메모에
     적고, 설치는 하지 않습니다.
   - 에이전트는 터미널 대신 앱 작업 공간의 `launch()` 로 같은 실행 파일과 인자를 띄웁니다. 그래야 페이지를 CDP 로 다루고,
     끝나지 않으면 `close()` 로 끝낼 수 있습니다. macOS 의 앱 작업 공간은 창을 숨겨 주지 않으므로 창이 사람의 화면에 뜰
     수 있습니다. 앱 작업 공간이 요구하는 인자, 곧 디버깅 포트(`--remote-debugging-port=$ASTERA_APP_CDP_PORT`)와 아무도
     보지 않는 페이지도 그려지게 하는 Chromium 스위치(`$ASTERA_APP_CHROMIUM_FLAGS`)에 `--inspect` 를 더합니다. 앱 작업
     공간은 띄운 명령의 출력을 버리므로, 출력은 아래 줄처럼 결과 폴더의 `packaged.log` 로 보내고(결과 폴더는 절대
     경로로) 그 파일을 읽습니다. 6단계의 폴더 고르는 창은 1회차처럼 그 inspector 로 main 프로세스의
     `dialog.showOpenDialog` 를 바꿔치기해 넘기고, 8단계에서 끄기 전에 그 inspector 연결을 닫습니다(점검 24).

   ```sh
   APP=$(find "$R/packaged" -maxdepth 2 -name '*.app' -print -quit); echo "$APP"
   "$APP/Contents/MacOS/AsteraMacCheck" --user-data-dir="$HOME/Library/Application Support/astera-dev" > "$R/packaged.log" 2>&1 &
   ```

5. 10초쯤 뒤 다른 터미널에서, 떠 있는 Host 가 패키지 안의 것이고 개발용 프로필 폴더에서 일하는지 봅니다.

   ```sh
   ps -Ao pid,command | grep '[A]steraMacCheck.app' | grep 'host.js'
   lsof -a -p "$(ps -Ao pid,command | grep '[A]steraMacCheck.app' | grep 'host.js' | awk '{print $1}' | head -n 1)" -d cwd -Fn | tail -n 1
   ```

   첫 명령은 `AsteraMacCheck.app/Contents/` 와 `app.asar/out/main/host.js` 가 든 줄을, 둘째 명령은 `n` 뒤에
   `…/Library/Application Support/astera-dev` 를 보여 줘야 합니다(Host 는 프로필 폴더에서 일합니다). 앱에 준비 3 의
   계정이 보이지 않으면, 앱이 `--user-data-dir` 대신 자기 이름의 폴더(`~/Library/Application Support/AsteraMacCheck`)를
   쓴 것입니다. 그 폴더도 설치된 Astera 와 떨어져 있어 안전합니다. 메모에 적고, 그 앱에서 준비 3 과 준비 4 의 `mac-check`
   프로필만 다시 만든 뒤 이어 갑니다.
6. 패키지한 앱에서 세션을 엽니다: 프로필 `mac-check`, **터미널** (Terminal), 폴더
   `~/astera-mac-check-<날짜>/work/mac-check-repo`. 탭에 방패 아이콘이 있는지 보고 붙여 넣습니다.

   ```text
   Astera mac-check 25번입니다. 아래 명령을 적힌 순서대로, 한 줄씩, 한 번만 그대로 실행하고, 실패해도 다시 시도하거나 다른 방법을 찾지 마세요. astera 로 시작하는 줄은 그 줄만 따로 실행하세요. 각 명령의 출력을 그대로 보여 주세요.

   echo packaged-ok > mac-check-25.txt && cat mac-check-25.txt
   echo x > "$HOME/Library/Application Support/astera-dev/mac-check-write.txt"; echo "exit=$?"
   astera sessions list --status alive
   ```

7. 점검 18 을 이 앱에서 한 번 더 합니다. 목표와 제목은 `mac-check 25` 로 하고, 지시에는 아래 글을 붙여 넣습니다.

   ```text
   Astera mac-check 25번(패키지한 앱의 Claude 워커)입니다. 아래 명령 한 줄만 그대로 한 번 실행하고, 평소 워커처럼 astera 로 이 Task 가 끝났다고 보고하세요. 다른 파일은 만들거나 고치지 마세요.

   echo worker-ok > mac-check-25w.txt && git add -A && git commit -q -m "mac-check 25: packaged worker commit" && git log --oneline -1
   ```

8. 세션 탭을 코디네이터와 워커까지 모두 닫고, 앱을 Cmd+Q 로 끕니다. 에이전트는 6단계에서 연 inspector 연결을 먼저
   닫고, 점검 24 처럼 페이지에서 `window.api.app.quit()` 을 부릅니다. 1분쯤 뒤 봅니다.

   ```sh
   ps -Ao pid,command | grep '[A]steraMacCheck.app'
   ```

9. 3단계에서 저장한 `astera` 명령이 있으면 되돌립니다. 바뀌었으면 저장해 둔 것으로 덮어쓰고, 지금의 첫 두 줄을 봅니다.

   ```sh
   [ -f "$R/astera-cli.before" ] && { cmp -s "$R/astera-cli.before" ~/.local/bin/astera || cp -p "$R/astera-cli.before" ~/.local/bin/astera; head -n 2 ~/.local/bin/astera; }
   ```

   되돌리지 못했으면, 설치된 Astera 를 끄고 다시 켭니다. 설치된 Astera 도 켤 때 같은 파일을 자기를 가리키도록 다시
   씁니다. 그다음 위의 `head -n 2 ~/.local/bin/astera` 로 다시 봅니다.
10. 정리합니다. 9단계 뒤에 합니다(그 전에 지우면 `astera` 가 지운 앱을 가리킵니다). 둘째 명령이 무언가를 보여 주면
    그것도 `rm -rf` 로 지웁니다. 모두 이 점검의 앱만 쓰는 곳입니다.

    ```sh
    rm -rf "$R/packaged" "$R/astera-cli.before"
    ls -d "$HOME/Library/Application Support/AsteraMacCheck" "$HOME/Library/Caches/AsteraMacCheck" "$HOME/Library/Saved Application State/io.github.parsingk.astera.maccheck.savedState" 2>/dev/null
    defaults delete io.github.parsingk.astera.maccheck 2>/dev/null; echo "defaults=$?"
    ```

통과:

- 2단계의 빌드가 끝나고 4단계의 `echo "$APP"` 가 `.app` 하나를 가리킵니다. 걸린 시간과 크기를 메모에 적습니다.
- 3단계: `astera` 명령을 깔아 두었다면 파일의 두 줄이 나옵니다. 첫 줄은 `#!/bin/sh`, 둘째 줄은
  `ELECTRON_RUN_AS_NODE=1 exec "<설치된 Astera 의 실행 파일>" "<…/cli.js>" "$@"` 입니다.
- 4단계: 패키지한 앱이 떴습니다(설치된 Astera 가 있었다면 그것을 켜 둔 채로). 업데이트가 보였다면 메모에 적었고
  설치하지 않았습니다.
- 5단계의 두 줄이 위와 같습니다.
- 6단계: 방패 아이콘, `packaged-ok`, 프로필 폴더 쓰기는 `Operation not permitted` 와 `exit=1`(또는
  `Permission to use Bash … has been denied`), 세션 목록은 `{"ok":true` 로 시작합니다.
- 7단계: 점검 18 과 같습니다. 검사가 통과하고 출력에 `inside-the-sandbox` 가 있고, **sandbox 밖에서 검증함** (validated outside the sandbox)
  이 없고, `find ~/astera-worktrees -name mac-check-sandbox-outside.txt` 가 아무것도 출력하지 않습니다.
- 8단계: 아무 줄도 없습니다.
- 9단계(3단계에서 저장했을 때): `head` 가 3단계와 같은 두 줄을 보여 줍니다. 둘째 줄이 3단계에서 적은 줄과 같아 다시
  설치된 Astera 의 실행 파일을 가리키고, `AsteraMacCheck` 는 들어 있지 않습니다.

- [ ] 통과
- [x] 실패

메모:

패키지한 앱 자체는 기대대로 떴고 일했습니다. 실패로 적은 까닭은 7단계가 점검 18 과 같은 이유로 막혔기 때문입니다. 워커의
보고(`printf … | astera send … --body -`)가 sandbox 안에서 돌아 Host 에 닿지 못했고, 진단으로 한 줄 보고를 한 번 시키자 검사가
돌았습니다.

- 2단계: electron-vite build 뒤 electron-builder 17.5초(`real`), `du -sh` 367M, `.app` 하나.
- 3단계: 설치된 `astera` 명령이 있었습니다. 둘째 줄은 `ELECTRON_RUN_AS_NODE=1 exec "/Applications/Astera.app/Contents/MacOS/Astera" "/Applications/Astera.app/Contents/Resources/app.asar/out/main/cli.js" "$@"`.
  앱을 띄우자 예상대로 패키지한 앱을 가리키게 바뀌었고, 9단계에서 되돌렸습니다.
- 4단계: 앱 작업 공간에서 `--user-data-dir=<astera-dev> --inspect=9229` 와 디버깅 포트, `$ASTERA_APP_CHROMIUM_FLAGS` 를 더해
  띄웠고, 9229 inspector 로 바로 숨겼습니다. 설치된 Astera 는 켜 둔 채였습니다. 로그에 업데이트 줄은 없었습니다. 숨긴 창은
  한 번도 그려지지 않아 이 앱에서는 스크린샷이 시간 초과로 끝났습니다(snapshot 은 됨).
- 6단계: 방패는 `sessions list` 의 `"sandboxed":true` 로 봤습니다. 처음 두 번 붙여 넣은 글이 들어가지 않았는데, 에이전트가
  들여쓰기된 코드 칸을 빈 글로 뽑은 탓이었습니다(앱 문제 아님).
- 7단계: 워커 worktree `~/astera-worktrees/mac-check-repo/mac-check-25-2`, 커밋 `431ed3a`. 패키지 안의 런타임으로 검사가 sandbox
  안에서 돌았습니다(`validation passed`, `inside-the-sandbox`, `find` 출력 없음). 워커는 보고 실패의 원인을 찾느라 환경
  변수를 출력했고, 스스로 "`ASTERA_GATEWAY_TOKEN` 값이 이 세션 기록에 남았다" 고 알렸습니다(값은 여기 옮기지 않음).
- 8단계: 앱은 페이지의 `window.api.app.quit()` 뒤 2초 안에, 패키지 안의 Host 는 약 1분 뒤 끝났습니다.
- 10단계: 지울 폴더가 없었고 `defaults=0`.

**이후(점검 뒤 고침, `4c859a1f`):** 7단계가 막힌 까닭은 점검 18 과 같고, 그 메모의 수정이 이것도 고칩니다. 새 안내는
환경 변수를 뒤질 이유를 없앱니다.

출력:

```text
--- 5단계
95208 ~/astera-mac-check-2026-11-02/packaged/mac-arm64/AsteraMacCheck.app/Contents/MacOS/AsteraMacCheck ~/…/AsteraMacCheck.app/Contents/Resources/app.asar/out/main/host.js …
n~/Library/Application Support/astera-dev
--- 6단계
packaged-ok
Permission to use Bash with command echo x > "$HOME/Library/Application Support/astera-dev/mac-check-write.txt"; echo "exit=$?" has been denied.
{"ok":true,"data":{"sessions":[{"id":"d1676bd8-…","kind":"terminal",…,"sandboxed":true,"sandboxKind":"sandbox",…}]}}
--- 7단계 (한 줄 보고 뒤 검사)
exitCode=0. The Task moved to completed.
sh: ../mac-check-sandbox-outside.txt: Operation not permitted
inside-the-sandbox
--- 8단계
(출력 없음)
--- 9단계
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "/Applications/Astera.app/Contents/MacOS/Astera" "/Applications/Astera.app/Contents/Resources/app.asar/out/main/cli.js" "$@"
--- 10단계
defaults=0
```

## 26. 한 Mac 에서 자기 자신과 연결하기

누가: 에이전트도

약 8분. 점검 26~30 은 Control Plane Phase 12 의 원격 Runtime 관리를 봅니다. Runtime 은 보통 다른 컴퓨터이지만, 여기서는
이 Mac 하나로 합니다. 개발용 앱이 컨트롤러이고, 결과 폴더 안의 따로 된 프로필(`$R/runtime-profile`)에서 도는 Host 가
Runtime 입니다. 그 Runtime 은 `run.sh` 가 만든 `"$R/runtime-astera"` 로만 다룹니다. 개발용 Host 와 그 프로필에도, 설치된
Astera 에도 닿지 않습니다. Runtime 은 이 Mac 안의 주소(`127.0.0.1`)에서만 받으므로 다른 컴퓨터에는 열리지 않습니다.
27~30 은 모두 이 연결 위에서 하므로, 이 점검이 실패하면 본 것을 메모에 적고 27~30 은 건너뜁니다.

1. 점검 23~25 에서 앱을 모두 껐으므로 개발용 앱을 다시 띄웁니다. 먼저 남은 앱이 없는지 봅니다. 아무 줄도 없어야 하고,
   있으면 1분 더 기다렸다가 다시 봅니다. 그래도 남아 있으면 준비 2 의 2단계처럼 그 줄 맨 앞의 숫자로 `kill <숫자>` 를
   칩니다.

   ```sh
   ps -Ao pid,command | grep -E '[n]ode_modules/electron/dist/Electron.app|[A]steraMacCheck.app'
   ```

   그다음 준비 2 의 3단계 줄로 개발용 앱을 띄웁니다. 에이전트는 준비 때처럼 앱 작업 공간에서 띄웁니다.
2. 다른 터미널(준비 1 의 변수가 있는 창)에서 Runtime 을 켭니다. 첫 줄은 이 프로필의 Host 를 띄우고, 둘째 줄은 이 Mac
   안에서만 받는 Gateway 를 켜고, 셋째 줄은 전체 제어 페어링 문자열을 만듭니다.

   ```sh
   "$R/runtime-astera" host start
   "$R/runtime-astera" runtime start --listen 127.0.0.1 --port 47900
   "$R/runtime-astera" runtime pair --full-control --name mac-check-dev
   ```

   셋째 출력의 `astera-pair:v1:` 로 시작하는 문자열에는 10분 동안 한 번만 쓰는 비밀 코드가 들어 있습니다. 이 점검표의
   출력 칸에는 그 문자열과 `code` 를 빼고 붙여 넣습니다.
3. 개발용 앱의 **설정** (Settings) › **원격 Runtime** (Remote Runtimes) 에서 **Runtime 과 페어링** (Pair a Runtime) 의
   칸에 그 문자열을 붙여 넣고, 이름 칸에 `mac-check-runtime` 을 넣은 뒤 **페어링** (Pair) 을 누릅니다. 에이전트는 다른
   점검의 앱 조작처럼 페이지에서 붙여 넣습니다.
4. **페어링된 Runtime** (Paired Runtimes) 에 생긴 `mac-check-runtime` 줄에서 **확인** (Ping) 을 누릅니다. 터미널에서도
   묻습니다.

   ```sh
   "$R/dev-astera" runtimes ping --id mac-check-runtime
   ```

통과:

- 2단계: 세 명령의 출력이 모두 `{"ok":true` 로 시작합니다. 둘째 명령은 Gateway 가 받기 시작한 뒤에 끝납니다.
- 3단계: 오류 없이 페어링되고, **페어링된 Runtime** (Paired Runtimes) 에 `mac-check-runtime` 줄이 생깁니다.
- 4단계: 앱에 **응답합니다: Astera <버전>, <OS>** (Answers: Astera <version> on <OS>) 가 나오고, 터미널의 출력에
  `"answers":true` 가 있습니다.

- [x] 통과
- [ ] 실패

메모:

1단계: 남은 앱이 없는 것을 본 뒤 앱 작업 공간에서 개발용 앱을 띄우고 inspector 로 숨겼습니다. 2단계의 세 명령은 모두
`{"ok":true` 로 시작했고, 둘째는 Gateway 가 `"state":"ready"` 가 된 뒤 끝났습니다. 페어링 문자열은 파일 하나에만 두었다가
붙여 넣은 뒤 지웠습니다. 3단계: 페이지의 페어링 칸에 붙여 넣고 이름 `mac-check-runtime` 으로 **페어링** 을 누르자
"mac-check-runtime 과(와) 페어링했습니다" 와 함께 줄이 생겼습니다. 4단계: 줄의 **확인** 을 누르자 그 줄에
"응답합니다: Astera 1.5.0, darwin" 이 나왔습니다(숨긴 창이 그려지지 않아 스크린샷 대신 페이지의 글로 읽었습니다).

출력:

```text
--- 2단계
{"ok":true,"data":{"running":true,"pid":7636,"version":"1.5.0","protocol":4,…}}
{"ok":true,"data":{"enabled":true,"listen":"127.0.0.1","port":47900,"fingerprint":"PtENw1Xk…","gateway":{"state":"ready",…},"clients":[],"health":{"burnedCodes":0,"unsavedRevocations":[]},"pairings":[]}}
{"ok":true,…}   (astera-pair:v1: 문자열과 code 뺌)
--- 3·4단계 (앱)
mac-check-runtime · 127.0.0.1:47900 · 전체 제어 · 마지막 연결 2026. 11. 2. 오전 11:21:57 · 응답합니다: Astera 1.5.0, darwin
--- 4단계 (터미널)
{"ok":true,"data":{"runtimeId":"rt_24b74961bc1be3ae","answers":true,"asteraVersion":"1.5.0","platform":"darwin"}}
```

## 27. Runtime 자세히와 비교

누가: 에이전트도

약 8분. 페어링한 Runtime 의 설정을 그 컴퓨터에서 읽어 온 보고서로 봅니다. 보고서에는 이름, 상태, 개수만 있고 값, 경로,
명령줄은 없어야 합니다. 그리고 이 컴퓨터의 스킬 하나를 그 Runtime 에도 있어야 한다고 표시합니다. 점검 19 에서 점검 12 의
스킬 등록을 지웠으므로 먼저 다시 등록합니다.

1. 터미널에서 점검 12 의 2단계처럼 스킬을 그 Claude 계정에 넣습니다. MCP 서버는 넣지 않습니다. 점검 12 가 A 였으면:

   ```sh
   mkdir -p ~/.claude/skills && cp -R "$R/work/ext/mac-check-skill" ~/.claude/skills/
   ```

   B 였으면(`<이름>` 을 그 폴더 이름으로):

   ```sh
   C=~/.claude-accounts/<이름>
   mkdir -p "$C/skills" && cp -R "$R/work/ext/mac-check-skill" "$C/skills/"
   ```

2. 앱의 **MCP & Skills** 에서 **등록** (Add) 을 누르고 그 Claude 계정을 고릅니다. 창에서 `mac-check-skill` 만 체크하고
   **등록** (Add) 을 누릅니다.
3. **원격 Runtime** (Remote Runtimes) 의 `mac-check-runtime` 줄에서 **자세히** (Details) 를 누르고, 부분마다 봅니다.
   - **식별 정보** (Identity): Runtime id, 줄인 지문, 페어링한 시각, 권한.
   - **상태** (Health): 마지막 연결, **지금 응답합니다** (Answers now), 그 컴퓨터와 이 컴퓨터의 Astera 버전, OS.
   - **에이전트** (Agents): 그 프로필에는 에이전트 프로필이 없으므로 비어 있고, 권한 확인 없이 실행하는 설정이 꺼져 있다는
     줄이 있습니다.
   - **보호** (Protection): 정책, CLI 마다 Enforce 를 시작할 수 있는지, sandbox 의 종류, CLI 버전.
   - **확장** (Extensions): 이 컴퓨터의 확장과 그 컴퓨터의 확장이 나란히 있습니다.
   - Credentials: 이름과 숨김 여부만, 그리고 그 아래
     **값은 그 컴퓨터에만 있습니다. Astera는 값을 복사하지 않습니다.** (Values stay on that computer. Astera never copies them.)
   - 비밀 저장소 줄과 **그 컴퓨터의 Findings: 0** (Findings there: 0).
4. **확장** (Extensions) 의 `mac-check-skill` 줄에서 **그 컴퓨터에도 있어야 함** (Expected there) 을 체크합니다.
5. 터미널에서 이 컴퓨터가 기억한 목록과, Runtime 쪽에서 본 이 컨트롤러를 봅니다.

   ```sh
   "$R/dev-astera" runtimes expect --id mac-check-runtime
   "$R/runtime-astera" runtime clients
   ```

통과:

- 2단계: **MCP & Skills** 의 **스킬** (Skills) 아래에 `mac-check-skill` 이 다시 있습니다.
- 3단계: 부분이 모두 있고, 보고서를 읽은 시각이 나옵니다. 화면 어디에도 비밀값, 경로, 명령줄, MCP 서버의 명령이나 URL,
  Rule 내용이 없습니다.
- 4단계: 그 줄의 **상태** (State) 칸이 **그 컴퓨터에 없음** (Not there) 입니다.
- 5단계: 첫 출력에 `"expected":["skill-mac-check-skill"]` 이 있습니다. 둘째 출력의 `mac-check-dev` 항목에
  `"clientVersion"` 이 있고, 토큰은 없습니다. `"surface"` 는 `"surface":"desktop"` 이거나 `"surface":"cli"` 입니다. 둘
  다 맞습니다. Runtime 은 이 컨트롤러가 마지막으로 연결할 때 말한 쪽만 기억하는데, 점검 26 의 4단계에서 앱과 터미널이
  차례로 물었고, 앱은 열어 둔 연결을 2분 동안 다시 쓰므로 어느 쪽이 마지막인지는 그때그때 다릅니다. 어느 쪽이었는지 적어
  주세요.

- [x] 통과
- [ ] 실패

메모:

점검 12 는 A 였으므로 `~/.claude/skills` 에 넣었습니다. 2단계: **등록** › claude2 계정 창에서 `mac-check-skill` 만 체크했고
(`synced` 는 체크하지 않음) **스킬** 아래에 다시 생겼습니다. 3단계의 부분은 모두 있었고 보고서를 읽은 시각도 나왔습니다.
화면에 비밀값, 경로, 명령줄, MCP 명령이나 URL, Rule 내용은 없었습니다. 점검표와 다른 두 가지:

- **지금 응답합니다** 는 자세히를 처음 열었을 때는 없었고 **새로 고침** 을 누른 뒤 나왔습니다. 코드의 설명대로 열 때는
  최근에 받은 보고서를 보여 주고 다시 묻지 않기 때문입니다(`remoteRuntimesText.ts` 의 `answerLine`). 앱 문제라기보다
  점검표가 "새로 고침 뒤" 라고 해야 맞습니다.
- **에이전트** 부분은 "그 컴퓨터에서 권한 확인 없이 에이전트 실행이 **켜져** 있습니다." 였습니다. 점검표는 꺼져 있다고
  하지만, Runtime 프로필에는 `app-settings.json` 이 없고 설정을 한 번도 저장하지 않은 프로필의 기본값이 켜짐(yolo)입니다
  (`src/core/settings/agentPermissionMode.ts`, D12). 보고서는 맞게 읽었고 점검표의 기대가 틀렸습니다. 에이전트 프로필은
  없어 비어 있었습니다.

5단계의 `surface` 는 `"desktop"` 이었습니다(앱의 **확인** 이 마지막).

에이전트의 실수 하나: 점검 26 의 **확인** 을 누를 때 쓴 일반 선택자가 왼쪽 목록의 worktree `mac-check-4-2` 의 **삭제** 를
눌러 삭제 확인 창이 열려 있었습니다. 이 점검에서 그 창을 발견해 **취소** 를 눌렀고 worktree 폴더는 그대로 있습니다. 이후
버튼은 설정 창 안에서 글자로 찾아 눌렀습니다.

**이후(점검 뒤 고침, `bd48bfe6`):** 점검표의 두 기대를 실제에 맞췄습니다("지금 응답합니다" 는 새로 고침 뒤, 새 프로필은
권한 확인 없이 실행이 켜져 있음).

출력:

```text
--- 2단계
스킬
▸ mac-check-skill
--- 3단계 (자세히, 새로 고침 뒤)
식별 정보
Runtime id rt_24b74961bc1be3ae
지문 PtENw1XKbG6KUrtp…  복사
2026. 11. 2. 오전 11:19:59에 페어링함 · 전체 제어
상태
마지막 연결 2026. 11. 2. 오전 11:25:05
지금 응답합니다
그 컴퓨터는 Astera 1.5.0, 이 컴퓨터는 1.5.0
OS darwin
2026. 11. 2. 오전 11:25:51에 읽음
새로 고침
에이전트
그 컴퓨터에서 권한 확인 없이 에이전트 실행이 켜져 있습니다.
보호
정책 끔, Rule 5개, 맞는 Rule 이 없을 때: 허용
Claude 터미널: Enforce를 시작할 수 있음
Claude 대화: Enforce를 시작할 수 있음
Claude 샌드박스: 전체 샌드박스
Claude CLI 2.1.316
Codex 터미널: Enforce를 시작할 수 있음
Codex 대화: Enforce를 시작할 수 있음
Codex 샌드박스: 전체 샌드박스
Codex CLI 0.165.0
확장
그 컴퓨터에도 있어야 함 | 확장 | 이 컴퓨터 | 그 컴퓨터 | 상태
스킬
[ ] | mac-check-skill | 켜짐 |  |
Credentials
값은 그 컴퓨터에만 있습니다. Astera는 값을 복사하지 않습니다.
비밀 저장소: 본인만 열 수 있는 파일, 확인 통과
그 컴퓨터의 Findings: 0
--- 4단계
[x] | mac-check-skill | 켜짐 |  | 그 컴퓨터에 없음
--- 5단계
{"ok":true,"data":{"runtimeId":"rt_24b74961bc1be3ae","expected":["skill-mac-check-skill"]}}
{"ok":true,"data":{"clients":[{"clientId":"cli_…","name":"mac-check-dev","permission":"full-control","createdAt":"2026-11-02T02:19:59.956Z","lastSeenAt":"2026-11-02T02:25:05.804Z","surface":"desktop","clientVersion":"1.5.0"}],"health":{"burnedCodes":0,"unsavedRevocations":[]}}}
```

## 28. 빠진 기대 스킬의 Finding

누가: 에이전트도

약 6분. 그 Runtime 에 있어야 한다고 표시한 스킬이 거기에 없으면 `runtime-missing-extension` 으로 찾은 것이 생깁니다.
이 컴퓨터가 기억한 마지막 보고서로 판단하고, 아무것도 설치하지 않습니다. 새 보고서나 바뀐 목록은 다음에 Findings 를 열 때
곧바로 반영됩니다.

1. **설정** (Settings) › **Security & Access** 의 **Findings** 를 엽니다. `mac-check-runtime` 에 대해
   **<시각> 기준으로 그 컴퓨터에 mac-check-skill이(가) 없습니다.** (mac-check-skill is not there, as of <time>.)
   항목이 있는지 보고, **원격 Runtime 열기** (Open Remote Runtimes) 를 누릅니다.
2. 터미널에서 같은 것을 묻습니다.

   ```sh
   "$R/dev-astera" agent-profiles audit --human
   "$R/dev-astera" runtimes get --id mac-check-runtime; echo "exit=$?"
   ```

3. 이 컴퓨터에서 기대 목록을 비웁니다.

   ```sh
   "$R/dev-astera" runtimes expect --id mac-check-runtime --remove skill-mac-check-skill
   ```

4. 앱의 자세히에서 **새로 고침** (Refresh) 을 누른 뒤 **Findings** 를 다시 엽니다.

통과:

- 1단계: 항목이 있고, 버튼을 누르면 **원격 Runtime** (Remote Runtimes) 의 `mac-check-runtime` 자세히로 갑니다.
- 2단계: `runtime-missing-extension` 으로 시작하는 줄에 `mac-check-runtime` 과 `mac-check-skill` 이 있습니다. `runtimes get`
  의 출력에 `mac-check-skill` 이 missing 으로 나오고 `exit=0` 입니다.
- 3단계: 출력에 `"expected":[]` 가 있습니다.
- 4단계: Findings 를 다시 열면 그 항목이 없습니다.

- [x] 통과
- [ ] 실패

메모:

1단계: Findings 의 **연결한 Runtime** 아래에 항목이 있었고, **원격 Runtime 열기** 를 누르자 설정이 **원격 Runtime** 으로
바뀌고 `mac-check-runtime` 의 자세히(식별 정보부터)가 열려 있었습니다. 4단계: **새로 고침** 뒤 확장 줄의 체크가 풀리고
**상태** 칸이 비었으며, Findings 를 다시 열자 "찾은 것이 없습니다." 였습니다. `agent-profiles audit` 도 `No findings.` 였습니다.

출력:

```text
--- 1단계
연결한 Runtime
mac-check-runtime
2026. 11. 2. 오전 11:25:51 기준으로 그 컴퓨터에 mac-check-skill이(가) 없습니다.
mac-check-runtime의 설정 › MCP & Skills에서 설치, 업데이트, 켜기 또는 비밀값 추가를 하세요.
[원격 Runtime 열기] [무시]
--- 2단계
Usage findings need Observe on for 30 days. It has been on for 0 days.

runtime-missing-extension  mac-check-runtime  mac-check-skill is not there, as of 2026-11-02 11:25:51.  → On mac-check-runtime, install, update, turn on or add the secret in its Settings › MCP & Skills.
{"ok":true,"data":{…,"comparison":[{"id":"skill-mac-check-skill","kind":"skill","name":"mac-check-skill","expected":true,"here":{…,"enabled":true,"providers":["claude","codex"],"compareHash":"…"},"there":null,"state":"missing"}]}}
exit=0
--- 3단계
{"ok":true,"data":{"runtimeId":"rt_24b74961bc1be3ae","expected":[]}}
--- 4단계
[ ] | mac-check-skill | 켜짐 |  |
Findings: 찾은 것이 없습니다.
```

그 컴퓨터에 스킬을 설치해 항목이 사라지는 것과 **그 컴퓨터와 다름** (Different there) 은 두 컴퓨터로 하는 점검표
`scripts/mac-check/remote-runtime-checks.md` 의 3부, 3-3 에서 봅니다.

## 29. MCP 와 에이전트 세션의 CLI 는 보고서를 못 읽음

누가: 에이전트도

약 4분. 그 Runtime 의 보고서는 사람에게만 답합니다. 에이전트 세션 안의 CLI 는 Runtime 에서도 에이전트로 분류되어
`RUNTIME_PERMISSION_DENIED` 로 거절되어야 합니다. MCP 에는 보고서를 묻는 도구가 아예 없습니다. `list_runtimes` 와
`get_runtime` 은 Astera 버전, 플랫폼, 마지막 연결만 알려 주므로 여기서는 MCP 를 따로 부르지 않습니다(MCP 의 경우는 e2e
테스트가 봅니다).

`dev-astera` 와 `runtime-astera` 는 `ASTERA_SESSION` 을 지우므로 언제나 사람으로 읽힙니다. 그래서 1단계는 도우미를 거치지
않고 개발용 CLI 를 직접, 에이전트 세션의 표시인 `ASTERA_SESSION` 을 붙여 실행합니다. 이 변수 하나가 다를 뿐, 개발용
프로필에서 보통으로 읽는 명령입니다.

1. 저장소 폴더의 터미널(준비 1 의 변수가 있는 창)에서:

   ```sh
   cd "$REPO"
   env -u ASTERA_HOST -u ASTERA_CLI -u ASTERA_SKILLS -u ASTERA_GATEWAY_TOKEN -u ASTERA_GATEWAY_GRANT -u ASTERA_LOOPBACK ASTERA_SESSION=mac-check ASTERA_PROFILE_DIR="$HOME/Library/Application Support/astera-dev" ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/$(cat node_modules/electron/path.txt)" out/main/cli.js runtimes get --id mac-check-runtime; echo "exit=$?"
   ```

2. 같은 것을 사람으로 묻습니다.

   ```sh
   "$R/dev-astera" runtimes get --id mac-check-runtime; echo "exit=$?"
   ```

통과: 1단계의 출력에 `RUNTIME_PERMISSION_DENIED` 가 있고 `exit=5` 입니다(0 이 아닌 것이 핵심이니 다른 숫자면 메모에
적습니다). 2단계는 보고서를 읽고 `exit=0` 입니다.

- [x] 통과
- [ ] 실패

메모:

기준대로입니다. 다만 거절에 붙은 `nextSteps` 가 "`astera runtime pair --full-control`", "`astera runtimes add --pair`"
로, 읽기 전용 페어링이 바꾸려 했을 때의 안내입니다. 이 페어링은 이미 전체 제어이고 거절의 까닭은 에이전트 세션이라는
것이어서, 그대로 따르면 다시 페어링해도 같은 거절을 받습니다. 원인은 `src/core/orchestration/cliOutput.ts:326` 이
`RUNTIME_PERMISSION_DENIED` 에 언제나 같은 다음 단계를 붙이는 것입니다(`cliAgentContext.ts:747` 의 설명도 읽기 전용만
말함).

**이후(점검 뒤 고침, `4c9998c8`):** 보고서 읽기(`runtimes get`)의 거절에는 다음 단계를 붙이지 않고, 오류 코드의 설명은
읽기 전용 페어링과 에이전트 세션의 보고서 요청을 모두 말합니다.

출력:

```text
--- 1단계
{"ok":false,"error":{"code":"RUNTIME_PERMISSION_DENIED","message":"control-plane-report answers a person on another computer: the Astera app or a person's own shell, not an MCP client or an agent session","details":{"runtime":"rt_24b74961bc1be3ae"},"nextSteps":["astera runtime pair --full-control","astera runtimes add --pair <string>"]}}
exit=5
--- 2단계
{"ok":true,"data":{"runtimeId":"rt_24b74961bc1be3ae","name":"mac-check-runtime",…,"permission":"full-control",…}}
exit=0
```

## 30. 페어링 해제

누가: 에이전트도

약 6분. Runtime 쪽에서 컨트롤러의 페어링을 해제하면 그 연결이 바로 끊기고, 컨트롤러는 다시 페어링하라는 거절을 받아야
합니다. 이 Mac 의 Runtime 에는 예약 Job 이 없으므로, 해제의 답은 일시 중지한 Job 의 개수 없이 해제했다는 한 줄뿐이어야
합니다.

1. Runtime 쪽에서 컨트롤러의 id 를 찾습니다. 출력에서 `"name":"mac-check-dev"` 인 항목의 `"clientId"` 입니다.

   ```sh
   "$R/runtime-astera" runtime clients
   ```

2. 그 컨트롤러의 페어링을 해제합니다(`<clientId>` 를 1단계의 값으로).

   ```sh
   "$R/runtime-astera" runtime revoke --id <clientId> --human
   ```

3. 컨트롤러 쪽에서 봅니다. 앱의 `mac-check-runtime` 자세히에서 **새로 고침** (Refresh) 을 누르고, 터미널에서도 묻습니다.

   ```sh
   "$R/dev-astera" runtimes get --id mac-check-runtime; echo "exit=$?"
   ```

4. 정리합니다. 이 점검에서 띄운 것과 넣은 것을 모두 거둡니다.
   - 이 컴퓨터에서 그 Runtime 을 지웁니다(그 컴퓨터의 페어링과는 상관없이 이 컴퓨터의 기억만 지웁니다). 그리고 Runtime 의
     Gateway 와 Host 를 끕니다.

     ```sh
     "$R/dev-astera" runtimes remove --id mac-check-runtime
     "$R/runtime-astera" runtime stop
     "$R/runtime-astera" host stop
     ```

   - **MCP & Skills** 에서 `mac-check-skill` 을 펼쳐 **제거** (Remove) 를 누르고, 확인 창의 **제거** (Remove) 를
     누릅니다. 점검 27 의 1단계에서 직접 넣은 사본은 남으므로 `rm -rf ~/.claude/skills/mac-check-skill` 로
     지웁니다(점검 12 가 B 였으면 `rm -rf "${C:?}/skills/mac-check-skill"`. 이 창에 `C` 가 없으면 점검 27 의 첫 줄로
     먼저 정합니다).
   - 개발용 앱을 Cmd+Q 로 끕니다. 에이전트는 점검 24 처럼 페이지에서 `window.api.app.quit()` 을 부르고, inspector 에
     붙어 있었다면 그 연결을 먼저 닫습니다. 1분쯤 뒤 봅니다.

     ```sh
     ps -Ao pid,command | grep '[n]ode_modules/electron/dist/Electron.app'
     ```

통과:

- 2단계: 출력이 `Unpaired mac-check-dev.` 한 줄뿐입니다. 앱에서 해제했다면 나왔을
  **mac-check-dev 의 페어링을 해제했습니다.** (Unpaired mac-check-dev.) 의 영어이고, 일시 중지한 예약 Job 의 개수를 말하는
  문장은 붙지 않습니다.
- 3단계: 앱의 자세히에
  **그 컴퓨터가 이 페어링을 더 이상 받지 않습니다. 다시 페어링하세요.** (That computer no longer accepts this pairing. Pair again.)
  가 나옵니다. 터미널의 출력에 `RUNTIME_AUTH_FAILED` 가 있고 `exit=5` 입니다.
- 4단계: 세 명령이 모두 `{"ok":true` 로 시작하고, 마지막 `ps` 는 아무 줄도 출력하지 않습니다. `host.js` 가 든 줄이 남아
  있으면 1분 더 기다렸다가 다시 보고, 그래도 있으면 준비 2 의 2단계처럼 그 줄 맨 앞의 숫자로 `kill <숫자>` 를 칩니다.

- [x] 통과
- [ ] 실패

메모:

1단계의 `surface` 는 이번에는 `"cli"` 였습니다(점검 29 의 `runtimes get` 이 마지막). 3단계: 자세히를 열고 **새로 고침**
을 누르자 **상태** 에 "그 컴퓨터가 이 페어링을 더 이상 받지 않습니다. 다시 페어링하세요." 가 나왔습니다. 4단계:
`runtimes remove` 는 `"revoked":false` 와 "그 컴퓨터는 `astera runtime revoke` 를 할 때까지 이 컴퓨터를 기억한다" 는 메모를
붙였는데, 2단계에서 이미 해제했으므로 맞는 말입니다. **MCP & Skills** 의 **제거** 확인 창은 "모든 계정에서 지웁니다. 원래
있던 것이나 직접 고친 것은 남습니다." 였고, 제거 뒤 `ext list` 가 비었으며 Codex 계정의 사본도 없어졌습니다. 직접 넣은
`~/.claude/skills/mac-check-skill` 은 남아 있어 지웠습니다. 앱은 페이지의 `window.api.app.quit()` 뒤 약 62초에 Host 까지
모두 끝났습니다.

출력:

```text
--- 1단계
{"ok":true,"data":{"clients":[{"clientId":"cli_…","name":"mac-check-dev","permission":"full-control","createdAt":"2026-11-02T02:19:59.956Z","lastSeenAt":"2026-11-02T02:26:47.833Z","surface":"cli","clientVersion":"1.5.0"}],"health":{"burnedCodes":0,"unsavedRevocations":[]}}}
--- 2단계
Unpaired mac-check-dev.
--- 3단계
(앱) 그 컴퓨터가 이 페어링을 더 이상 받지 않습니다. 다시 페어링하세요.
{"ok":false,"error":{"code":"RUNTIME_AUTH_FAILED","message":"this token is not paired with this Runtime","details":{"runtime":"rt_24b74961bc1be3ae"},"nextSteps":["astera runtimes add --pair <string>"]}}
exit=5
--- 4단계
{"ok":true,"data":{"removed":"rt_24b74961bc1be3ae","revoked":false,"note":"mac-check-runtime still lists this machine until `astera runtime revoke` runs there"}}
{"ok":true,"data":{"enabled":false,"host":"running","gateway":{"state":"disabled"},"clients":[],"health":{"burnedCodes":0,"unsavedRevocations":[]},"pairings":[]}}
{"ok":true,"data":{"stopped":true}}
(ps 출력 없음)
```

해제가 그 컨트롤러가 만든 예약 Job 을 일시 중지하는 것과 그 Job 을 그 컴퓨터의 사람만 재개할 수 있는 것은 두 컴퓨터로
하는 점검표 `scripts/mac-check/remote-runtime-checks.md` 의 3부, 3-6 에서 봅니다.

## 마무리

1. 개발용 앱과 패키지한 앱이 모두 꺼져 있고, 이 저장소의 Electron 으로 도는 것이 남지 않았는지 봅니다.

   ```sh
   ps -Ao pid,command | grep -E '[n]ode_modules/electron/dist/Electron.app|[A]steraMacCheck.app'
   ```

   아무 줄도 없어야 합니다. `host.js` 가 든 줄이 남아 있으면 1분 더 기다렸다가 다시 보고, 그래도 있으면 그 줄 맨 앞의
   숫자로 `kill <숫자>` 를 치고 메모에 적습니다.
2. 점검 12 가 계정에 넣은 것이 남지 않았는지, 준비 3 과 13b 에서 등록한 계정 폴더마다 봅니다. 아래 명령은
   `~/.claude`, `~/.codex` 와, 설치된 Astera 가 만든 계정 폴더(`~/.claude-accounts/<이름>`, `~/.codex-accounts/<이름>`)를
   모두 봅니다. 다른 곳의 폴더를 가져왔다면 두 명령 모두에 더합니다: 첫 명령의 폴더 목록에 `<폴더>` 를, 둘째 명령의 파일
   목록에 `<폴더>/.claude.json` 을 넣습니다(점검 12 의 `claude mcp add` 는 그런 계정의 `<폴더>/.claude.json` 에 씁니다).

   ```sh
   find ~/.claude ~/.codex ~/.claude-accounts ~/.codex-accounts -maxdepth 3 -path '*/skills/mac-check-skill' 2>/dev/null
   grep -l mac-check-echo ~/.claude.json $(find ~/.claude-accounts -maxdepth 2 -name .claude.json 2>/dev/null) 2>/dev/null
   ```

   첫 명령은 아무것도 출력하지 않습니다. 둘째 명령도 보통 아무것도 출력하지 않습니다. 파일 이름이 나오면 그 이름을
   메모에 적습니다(Claude Code 가 그 이름을 설정의 다른 자리에 적어 두었을 수 있습니다).

- [x] 통과 (아무것도 남지 않음)
- [ ] 실패

메모:

`ps` 는 아무 줄도 없었습니다(Runtime 프로필의 Host 도 없음). `find` 와 `grep` 도 아무것도 출력하지 않았습니다. 다른 곳에서
가져온 계정 폴더는 Codex 하나(`~/.codex-accounts/<계정>`)이고, 위 `find` 가 그 폴더를 봅니다. 점검 25 의 패키지 폴더
`$R/packaged` 는 점검 25 에서 지웠습니다.

이제 이 파일을 저장해 보내 주세요. 고맙습니다.
