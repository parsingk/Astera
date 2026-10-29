# Astera macOS 손 점검표 (mac-check)

이 파일은 `run.sh` 가 `~/astera-mac-check-<날짜>/checklist.md` 로 복사해 둔 **사본**에 채웁니다. 다 채운 그 사본 하나를
보내 주세요. 저장소 안의 원본(`scripts/mac-check/checklist.md`)은 고치지 마세요.

채우는 법:

- 통과하면 `- [ ] 통과` 를 `- [x] 통과` 로 바꿉니다. 실패하면 `- [x] 실패` 로 바꾸고, `메모` 에 무엇이 달랐는지 적습니다.
- '출력' 칸에는 세션이나 터미널이 보여 준 것을 그대로 붙여 넣습니다. 길면 앞뒤 몇 줄만 남겨도 됩니다.
- 비밀번호, 토큰, 키의 내용은 어디에도 붙여 넣지 마세요. 아래 명령은 그런 값을 출력하지 않습니다.
- 점검 하나가 막혀 더 나갈 수 없으면, 본 것을 메모에 적고 다음 점검으로 넘어갑니다.

## 자동 점검 결과

`run.sh` 가 아래 칸을 채웁니다. 직접 고치지 마세요.

<!-- run.sh summary start -->
(run.sh 를 돌리면 여기에 결과가 들어갑니다.)
<!-- run.sh summary end -->

## 준비

### 준비 1. 터미널의 결과 폴더 변수

이 점검표의 터미널 명령은 결과 폴더를 `R` 이라는 이름으로 씁니다. 터미널 창을 새로 열 때마다 먼저 이 줄을 칩니다.

```sh
R=$(ls -d ~/astera-mac-check-* | tail -n 1); echo "$R"
```

`/Users/<이름>/astera-mac-check-<날짜>` 가 나오면 됩니다.

### 준비 2. 개발용 앱 띄우기

1. 터미널 창을 하나 더 열고 저장소 폴더로 갑니다.
2. `npm run dev` 를 칩니다. 이 창은 앱을 끌 때까지 그대로 둡니다.
3. 앱 창이 뜨고 **새 세션을 무엇으로 시작할까요?** (What should new sessions be?) 라고 물으면 **터미널** (Terminal)
   을 고릅니다.
4. 앱이 뜨고 몇 초 뒤, 다른 터미널 창에서 개발용 프로필 폴더가 생겼는지 봅니다.

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
2. **에이전트 프로필** (Agent profile) 에서 점검이 말하는 프로필을 고릅니다.
3. **세션 방식** (Session type) 에서 **터미널** (Terminal) 이나 **대화** (Chat) 를 고릅니다.
4. **프로젝트 폴더** (Project folder) 의 **선택…** (Select…) 을 누릅니다. 폴더 고르는 창에서 Cmd+Shift+G 를 누르고
   점검이 말하는 경로를 붙여 넣은 뒤 열기를 누릅니다. `<날짜>` 는 준비 1의 `echo "$R"` 에 나온 날짜입니다.
5. **worktree로 분리해서 시작** (Start in a separate worktree) 은 끈 채로 둡니다.
6. **시작** (Start) 을 누릅니다.
7. Claude 나 Codex 가 이 폴더를 믿을지 물으면 믿는다고 답합니다.

sandbox 로 시작한 세션은 탭 이름 옆에 방패 아이콘이 있습니다. 마우스를 올리면
**Sandbox 안에서 실행 중** (Running in the sandbox) 이라고 나옵니다.

붙여 넣을 글은 코드 칸 하나를 통째로 복사해 세션에 붙여 넣고 Enter 를 누릅니다. 대화 세션이면 아래쪽 입력칸
**무엇을 시킬까요** (What should it do) 에 붙여 넣고 보냅니다.

## 1. sandbox 안의 Claude 터미널 세션, 보통 일

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

약 3분. 점검 1의 세션에 이어서 붙여 넣습니다.

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
- `security find-generic-password` 는 점검 8(sandbox 밖)과 다른 답을 냅니다. sandbox 밖에서는
  `The specified item could not be found in the keychain.` 과 `exit=44` 가 나옵니다. 여기서도 똑같이 나오면 키체인을
  열어 찾아볼 수 있었다는 뜻이니 실패로 적어 주세요.
- `security list-keychains` 는 키체인 경로 목록을 보여 줄 수도 있습니다. 그것만으로는 실패가 아닙니다. 출력만 붙여
  넣어 주세요.
- 프로필 폴더에 쓰기(`mac-check-write.txt`)는 `Operation not permitted` 와 `exit=1` 입니다.
- `host.key` 는 `64` 와 `exit=0` 입니다. 세션 안의 `astera` 가 Host 를 확인하는 데 이 파일을 읽어야 합니다.
- `app.key` 는 숫자 없이 `Operation not permitted`(또는 비슷한 거절)와 `exit=1` 입니다.

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
```

이 세션은 이제 닫아도 됩니다(탭의 **닫기** (Close)).

## 3. sandbox 안의 Claude 대화 세션

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
- 앞쪽(보통 일)은 점검 1과 같습니다. `ASTERA_LOOPBACK=` 뒤에 `http://127.0.0.1:` 로 시작하는 주소가 나옵니다. Codex 의
  sandbox 는 Host 의 소켓 폴더를 막으므로, 이 세션의 `astera` 는 이 주소로 Host 에 닿습니다.
- 뒤쪽(막혀야 하는 것)은 점검 2와 같습니다.
- Job 상세 창에서 Task 의 상태가 **끝났다** (Done) 로 바뀝니다. 워커가 sandbox 안에서 `astera` 로 보고한 것이 Host 에
  닿았다는 뜻입니다.

- [ ] 통과
- [ ] 실패

메모:

출력:

```text
```

## 5. sandbox 안의 Codex 대화: 끝냈다가 히스토리에서 이어하기

약 5분. 세션: 프로필 `mac-check-codex`, **대화** (Chat), 폴더 `~/astera-mac-check-<날짜>/work/mac-check-repo`.

1. 세션을 열고 다음 글을 보냅니다.

   ```text
   Astera mac-check 5번(첫 부분)입니다. 아래 명령 한 줄을 한 번만 그대로 실행하고 출력을 보여 주세요.

   pwd; echo chat5-ok > mac-check-5.txt && cat mac-check-5.txt
   ```

2. 답이 오면 탭의 **닫기** (Close) 로 세션을 끝냅니다.
3. **계정과 히스토리** (Accounts and history) 의 히스토리에서 `mac-check-repo` 를 펼치고, 방금 대화를 찾아 **세션 이어하기**
   (Resume session) 를 누릅니다.
4. 열린 창에서 **세션 방식** (Session type) 은 **대화** (Chat) 로 두고, 창에
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

약 4분. 세션: 프로필 `mac-check`, **터미널** (Terminal), 폴더는 홈 폴더(`/Users/<이름>`, 폴더 고르는 창에서
Cmd+Shift+H).

1. 세션을 엽니다. 터미널 위에 방패 모양 아이콘과 함께 다음 경고 한 줄이 떠야 합니다.

   **이 sandbox 세션의 작업 폴더가 홈 폴더를 포함하고 있어서, sandbox 안에서 홈 폴더의 프로그램과 설정을 바꿀 수 있습니다. 이것들을 지키려면 프로젝트 폴더에서 시작해 주세요.** (This sandboxed session's work folder contains your home folder, so programs and settings in your home folder can be changed from inside the sandbox. Start it in a project folder to keep them out of reach.)

   한 줄에 다 안 들어가면 끝이 잘립니다. 마우스를 올리면 전체 문장이 보입니다.
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
`Operation not permitted` 와 `exit=1`, `host.key` 는 `64` 와 `exit=0` 입니다.

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

약 3분. 세션: 프로필 `mac-check-plain`, **터미널** (Terminal), 폴더 `~/astera-mac-check-<날짜>/work/mac-check-repo`.

점검 2와 같은 명령을 sandbox 없이 돌립니다. 여기서는 되어야, 점검 2의 거절이 sandbox 때문이었다고 말할 수 있습니다.
키 파일과 폴더는 크기와 종료 코드만 보고 내용은 출력하지 않습니다.

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

다 보면 이 세션을 닫습니다. **에이전트 앱 작업 공간** (Agent app workspace) 은 다시 꺼도 됩니다.

## 10. 같은 폴더의 Codex 터미널 탭 두 개

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

## 마무리

1. 남은 세션 탭을 모두 닫습니다. 점검 4의 코디네이터 탭과 워커 탭도 닫습니다. 세션은 앱을 꺼도 Host 에서 계속 돌기
   때문에, 앱을 끄기 전에 닫아야 합니다.
2. 개발용 앱을 Cmd+Q 로 끕니다. `npm run dev` 를 띄운 터미널이 돌아오지 않으면 그 창에서 Ctrl+C 를 누릅니다.
3. 1분쯤 기다립니다. 세션이 없는 Host 는 마지막 연결이 끊기고 1분 뒤 스스로 끝납니다.
4. 터미널에서 이 저장소의 Electron 으로 돌던 것이 남았는지 봅니다.

   ```sh
   ps -Ao pid,command | grep '[n]ode_modules/electron/dist/Electron.app'
   ```

   아무 줄도 없어야 합니다. `out/main/host.js` 가 든 줄이 남아 있으면 그 줄 맨 앞의 숫자로 `kill <숫자>` 를 치고, 그
   사실을 메모에 적어 주세요.

- [ ] 통과 (아무것도 남지 않음)
- [ ] 실패

메모:

이제 이 파일을 저장해 보내 주세요. 고맙습니다.
