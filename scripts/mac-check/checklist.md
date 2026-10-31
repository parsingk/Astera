# Astera macOS 손 점검표 (mac-check)

이 파일은 `run.sh` 가 `~/astera-mac-check-<날짜>/checklist.md` 로 복사해 둔 **사본**에 채웁니다. 다 채운 그 사본 하나를
보내 주세요. 저장소 안의 원본(`scripts/mac-check/checklist.md`)은 고치지 마세요.

채우는 법:

- 통과하면 `- [ ] 통과` 를 `- [x] 통과` 로 바꿉니다. 실패하면 `- [x] 실패` 로 바꾸고, `메모` 에 무엇이 달랐는지 적습니다.
- '출력' 칸에는 세션이나 터미널이 보여 준 것을 그대로 붙여 넣습니다. 길면 앞뒤 몇 줄만 남겨도 됩니다.
- 비밀번호, 토큰, 키의 내용은 어디에도 붙여 넣지 마세요. 아래 명령은 그런 값을 출력하지 않습니다.
- `Operation not permitted` 는 셸에 따라 `operation not permitted` 처럼 소문자로도 나옵니다. 같은 뜻입니다.
- 점검 하나가 막혀 더 나갈 수 없으면, 본 것을 메모에 적고 다음 점검으로 넘어갑니다.

### 2회차에서 달라진 것

- **새 점검은 12번부터 25번까지입니다.** 1회차(2026-10-29, develop `d4831ff1`)에 없던 기능을 Mac 에서 처음 봅니다.
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
(run.sh 를 돌리면 여기에 결과가 들어갑니다.)
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

- [ ] 통과
- [ ] 실패

메모:

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

- [ ] 통과
- [ ] 실패

메모:

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

- [ ] 통과
- [ ] 실패

메모:

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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 6a 통과
- [ ] 6b 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과 (경고가 뜨고 쓰기가 막힘)
- [ ] 통과 (링크 때문에 시작이 거절됨)
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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
- [ ] 해당 없음 (`~/.config` 가 링크가 아님)

메모:

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
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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
- [ ] 해당 없음 (로그인된 Claude 계정이 하나)

메모:

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

- [ ] 통과
- [ ] 실패

메모:

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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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
- [ ] 실패

메모:

출력:

```text
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
     `rm -rf "$C/skills/mac-check-skill"`).

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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
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

출력:

```text
```

## 24. inspector 를 켜고 띄운 개발용 앱 끄기

누가: 에이전트도

약 4분. 1회차에서는 main 프로세스에 inspector 를 붙인 채 끄려 하자 앱이 끝나지 않았습니다. Node 는 붙어 있는
inspector 연결이 모두 끊길 때까지 끝나지 않기 때문입니다. 지금은 에이전트의 앱 작업 공간 안내서에 그 규칙이 있습니다(끄기
전에 inspector 연결을 닫을 것). 붙어 있는 연결이 없으면 inspector 를 켜고 띄운 앱도 몇 초 안에 끝나야 합니다.

1. 저장소 폴더의 터미널에서 inspector 를 켜고 띄웁니다. `Debugger listening on ws://127.0.0.1:5858/…` 줄이 나옵니다.
   에이전트는 터미널에서 띄우지 않고(창이 사람의 화면에 뜹니다), 앱 작업 공간의 `launch()` 로 같은 명령을 띄웁니다. 앱
   작업 공간이 요구하는 디버깅 포트 인자를 더하고, 위의 줄은 그 출력에서 봅니다.

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
아무 줄도 출력하지 않습니다(개발용 Host 의 줄은 빼고 봅니다). 끝나지 않으면 inspector 에 무엇이 붙어 있었는지 메모에
적고, 1단계의 터미널에서 Ctrl+C 를 누릅니다.

- [ ] 통과
- [ ] 실패

메모:

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
   없습니다. 그래서 띄우기 전에 복사해 두고 9단계에서 되돌립니다. 이 파일에는 실행 파일의 경로 두 개만 있고 비밀은
   없습니다. MCP 클라이언트에 Astera 를 등록해 두었다면 그 등록도 이 파일을 경로로 가리키므로, 이 파일과 함께 바뀌었다가
   함께 돌아옵니다.

   ```sh
   ls -l ~/.local/bin/astera 2>/dev/null && head -n 2 ~/.local/bin/astera && cp -p ~/.local/bin/astera "$R/astera-cli.before"
   ```

   아무것도 나오지 않으면 그 명령을 깔지 않은 것이니 9단계는 건너뜁니다. 나왔다면 둘째 줄(설치된 Astera 의 실행 파일을
   가리키는 줄)을 메모에 적습니다. 4단계부터 9단계까지는 터미널의 `astera` 가 패키지한 앱을 가리키므로, 그동안 설치된
   Astera 에 `astera` 명령을 쓰지 않습니다.
4. 앱을 띄웁니다. 이 터미널은 앱을 끌 때까지 그대로 둡니다.
   - 설치된 Astera 가 있으면 켜 둔 채로 띄웁니다. 설치된 Astera 가 자기 프로필 폴더를 잡고 있으므로, 패키지한 앱이 혹시
     그 폴더를 골랐다면 열지 못하고 곧바로 끝납니다(프로필 하나에 앱은 하나만 뜹니다).
   - 이 앱은 macOS 에게 처음 보는 앱이라, 키체인 접근을 묻는 창이 뜨면 개발용 앱 때처럼 거부를 누릅니다.
   - 패키지한 앱은 업데이트를 확인하고, 새 버전이 있으면 저절로 내려받기 시작합니다. 제목 줄에 업데이트가 보이면 메모에
     적고, 설치는 하지 않습니다.
   - 에이전트는 터미널에서 띄우지 않고(창이 사람의 화면에 뜹니다), 앱 작업 공간의 `launch()` 로 같은 실행 파일과 인자를
     띄웁니다. 앱 작업 공간이 요구하는 디버깅 포트 인자를 더합니다.

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

8. 세션 탭을 코디네이터와 워커까지 모두 닫고, 앱을 Cmd+Q 로 끕니다(에이전트는 점검 24 처럼 페이지에서
   `window.api.app.quit()`). 1분쯤 뒤 봅니다.

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
- 3단계: `astera` 명령을 깔아 두었다면 두 줄이 나오고, 둘째 줄이 설치된 Astera 의 실행 파일을 가리킵니다.
- 4단계: 패키지한 앱이 떴습니다(설치된 Astera 가 있었다면 그것을 켜 둔 채로). 업데이트가 보였다면 메모에 적었고
  설치하지 않았습니다.
- 5단계의 두 줄이 위와 같습니다.
- 6단계: 방패 아이콘, `packaged-ok`, 프로필 폴더 쓰기는 `Operation not permitted` 와 `exit=1`(또는
  `Permission to use Bash … has been denied`), 세션 목록은 `{"ok":true` 로 시작합니다.
- 7단계: 점검 18 과 같습니다. 검사가 통과하고 출력에 `inside-the-sandbox` 가 있고, **sandbox 밖에서 검증함** (validated outside the sandbox)
  이 없고, `find ~/astera-worktrees -name mac-check-sandbox-outside.txt` 가 아무것도 출력하지 않습니다.
- 8단계: 아무 줄도 없습니다.
- 9단계(3단계에서 저장했을 때): `head` 의 둘째 줄이 3단계에서 적은 줄과 같습니다. 다시 설치된 Astera 의 실행 파일을
  가리키고, `AsteraMacCheck` 는 들어 있지 않습니다.

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
```

## 마무리

1. 개발용 앱과 패키지한 앱이 모두 꺼져 있고, 이 저장소의 Electron 으로 도는 것이 남지 않았는지 봅니다.

   ```sh
   ps -Ao pid,command | grep -E '[n]ode_modules/electron/dist/Electron.app|[A]steraMacCheck.app'
   ```

   아무 줄도 없어야 합니다. `host.js` 가 든 줄이 남아 있으면 1분 더 기다렸다가 다시 보고, 그래도 있으면 그 줄 맨 앞의
   숫자로 `kill <숫자>` 를 치고 메모에 적습니다.
2. 점검 12 가 계정에 넣은 것이 남지 않았는지, 준비 3 과 13b 에서 등록한 계정 폴더마다 봅니다. 아래 명령은
   `~/.claude`, `~/.codex` 와, 설치된 Astera 가 만든 계정 폴더(`~/.claude-accounts/<이름>`, `~/.codex-accounts/<이름>`)를
   모두 봅니다. 다른 곳의 폴더를 가져왔다면 첫 명령의 폴더 목록에 그 폴더를 더합니다.

   ```sh
   find ~/.claude ~/.codex ~/.claude-accounts ~/.codex-accounts -maxdepth 3 -path '*/skills/mac-check-skill' 2>/dev/null
   grep -l mac-check-echo ~/.claude.json $(find ~/.claude-accounts -maxdepth 2 -name .claude.json 2>/dev/null) 2>/dev/null
   ```

   첫 명령은 아무것도 출력하지 않습니다. 둘째 명령도 보통 아무것도 출력하지 않습니다. 파일 이름이 나오면 그 이름을
   메모에 적습니다(Claude Code 가 그 이름을 설정의 다른 자리에 적어 두었을 수 있습니다).

- [ ] 통과 (아무것도 남지 않음)
- [ ] 실패

메모:

이제 이 파일을 저장해 보내 주세요. 고맙습니다.
