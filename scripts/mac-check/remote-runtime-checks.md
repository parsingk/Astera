# 원격 Runtime 수동 검증 (Windows PC + MacBook, 같은 LAN)

같은 공유기 아래의 Windows PC 와 MacBook 으로 원격 Runtime 을 직접 확인하는 순서다. 1부는 Windows 가 일하는
쪽(Runtime), Mac 이 조종하는 쪽(컨트롤러)이다. 2부는 방향을 바꿔 Mac 을 Runtime 으로 쓴다. 사용법 자체는
`docs/remote-runtime.md` 에 있다.

각 항목은 **할 일 → 정상이면 보이는 것** 순서다. 다르게 나오면 그 항목 옆에 본 것을 적어 둔다.

## 0. 준비

- [ ] 두 컴퓨터 모두 Astera 1.4.9 이상이다(앱 정보 또는 `astera version`). 버전이 다르면 `RUNTIME_PROTOCOL_MISMATCH`
      가 날 수 있으니 같은 버전으로 맞춘다.
- [ ] 두 컴퓨터 모두 설정 › CLI 에서 명령줄이 켜져 있고, 새 터미널에서 `astera version` 이 된다.
- [ ] Windows 앱에 Claude 계정이 하나 이상 로그인되어 있다. 2부까지 할 거면 Mac 앱에도 하나.
- [ ] `astera runtime status` → `{"ok":true,"data":{"enabled":false,"listen":"127.0.0.1","port":47831,...}}`.

명령은 **일반 터미널**에서 실행한다(Windows Terminal, macOS 터미널). Astera 세션 안의 터미널에서는
`runtime start`, `runtime pair`, `projects add` 가 거절된다.

**주소.**

- [ ] Windows IP: `ipconfig` 의 Wi-Fi 또는 이더넷 IPv4 (이하 `WIN_IP`, 예: 192.168.0.10)
- [ ] Mac IP: `ipconfig getifaddr en0` (이하 `MAC_IP`)
- [ ] Mac 에서 `ping WIN_IP`, Windows 에서 `ping MAC_IP` 가 응답한다.
- [ ] Windows 의 현재 네트워크가 **개인** 네트워크다(설정 › 네트워크 및 인터넷 › 속성). 공용이면 방화벽이
      들어오는 연결을 막는다.

## 1부. Windows = Runtime, Mac = 컨트롤러

### 1-1. Runtime 켜기 (Windows)

- [ ] `astera runtime start --listen WIN_IP` → 기다렸다가 끝나고, 주소·포트(47831)·지문을 알려 준다.
- [ ] (1.4.11 이상) 같은 일을 앱에서: 설정 › 원격 Runtime › 이 컴퓨터에서 WIN_IP 를 고르고 켜기 → "원격 Runtime 을 켰습니다". 가상 어댑터(vEthernet Default Switch, WSL) 주소는 목록에 없다.
- [ ] Windows 방화벽 창이 뜨면 **개인 네트워크** 허용을 누른다.
- [ ] `astera runtime status` → 게이트웨이가 `WIN_IP:47831` 에서 듣는다고 나온다.
- [ ] Windows 앱 설정 › 원격 Runtime › 이 컴퓨터: "원격 Runtime 이 켜져 있습니다: WIN_IP:47831, ..." 와 지문.
- [ ] 테스트용 저장소를 등록한다: `astera projects add --path D:\work\테스트저장소` (git 저장소, 망가져도 되는 것)

### 1-2. 페어링 (읽기 전용 먼저)

- [ ] Windows: `astera runtime pair --name macbook` → `astera-pair:v1:WIN_IP:47831:...` 문자열 하나.
- [ ] (1.4.11 이상) 앱에서: 이 컴퓨터 › 페어링 문자열 만들기 (읽기 전용, 이름 macbook) → 문자열, 남은 시간, 복사 버튼. 전체 제어를 고르면 경고가 뜬다.
- [ ] 문자열을 Mac 으로 옮긴다(메신저나 공유 문서 말고 직접 입력, AirDrop 등).
- [ ] Mac 앱 설정 › 원격 Runtime › Runtime 과 페어링: 붙여 넣고 이름 `office`, 페어링
      → "office 과(와) 페어링했습니다." 페어링된 Runtime 목록에 **읽기 전용** 표시.
- [ ] 확인 버튼 → "응답합니다: Astera 1.4.9, win32".
- [ ] 같은 문자열을 다시 페어링 → 거절된다(코드는 한 번만 쓴다).
- [ ] Windows 앱 이 컴퓨터 › 페어링된 컨트롤러에 macbook 이 보인다. `astera runtime clients` 에도 나온다.

### 1-3. 읽기 전용이 지켜지는지 (Mac)

- [ ] `astera --runtime office projects list` → 1-1 에서 등록한 저장소.
- [ ] `astera --runtime office accounts list` → Windows 앱의 계정들.
- [ ] `astera --runtime office jobs create --objective "test" --cwd 'D:\work\테스트저장소'`
      → `RUNTIME_PERMISSION_DENIED` (exit 5). Windows 에 Job 이 생기지 않았다.
- [ ] `astera --runtime office host status` → `RUNTIME_CAPABILITY_MISSING` (이 컴퓨터 전용 명령).
- [ ] Mac 앱 Jobs 화면의 Runtime 선택에서 office 를 고르면, 버튼이 꺼져 있고 "읽기 전용: ..." 이유가 보인다.

### 1-4. 전체 제어로 다시 페어링

- [ ] Windows: `astera runtime pair --full-control --name macbook-full`
- [ ] Mac: 설정 › 원격 Runtime 에서 office 를 지우고("페어링은 office 에서 해제할 때까지 남아 있습니다" 확인),
      새 문자열로 페어링 → **전체 제어** 표시.
      CLI 로 해 보려면 대신 `astera runtimes add --pair -` 에 붙여 넣고 Ctrl+D.
- [ ] Windows: `astera runtime clients` 에 예전 macbook 이 아직 남아 있다(Mac 에서 지운다고 해제되지 않는다).
      `astera runtime revoke --id <그 clientId>` 로 해제해 둔다. (1.4.11 이상은 이 컴퓨터 › 페어링된 컨트롤러의 "해제" 버튼으로도.)

### 1-5. 원격 Job (Mac 앱)

- [ ] Jobs › Runtime: office, 프로젝트: 테스트 저장소. "여기서 하는 동작은 office 에서 실행됩니다." 문구.
- [ ] 작은 Job 을 만든다(예: "README 에 한 줄 추가"). 실행.
- [ ] Mac 에서 Run 의 진행, Task, 타임라인이 갱신된다.
- [ ] Windows 앱 Jobs 에도 같은 Job 이 돌고 있다. 일하는 claude 프로세스는 Windows 에서 돈다.
- [ ] Run 이 끝나면 Mac 의 Run 상세에 바뀐 파일 목록이 나오고, 파일을 누르면 diff 가 Windows 에서
      `git diff` 한 것과 같다.
- [ ] 질문이 생기는 Job 이면 Mac 에서 답하고, Windows 쪽에서 이어진다.
- [ ] Job 일시정지 → 재개 → 삭제가 Windows 쪽에도 그대로 반영된다.

### 1-6. 원격 Job (Mac CLI)

```sh
astera --runtime office jobs create --objective "test 파일 하나 추가" --cwd 'D:\work\테스트저장소'
astera --runtime office jobs run --id <jobId>
astera --runtime office runs follow --id <runId>
astera --runtime office runs-changed-files --id <runId>
```

- [ ] 각 명령이 성공하고, `runs follow` 가 끝날 때까지 진행을 보여 준다.
- [ ] `--cwd` 없이 `jobs create` → 거절된다(Mac 의 폴더는 Runtime 에서 의미가 없다).

### 1-7. 원격 세션

- [ ] Mac 앱 새 세션 › 실행할 컴퓨터: office → "원격 세션" 창. 계정(그 컴퓨터의 계정), 폴더(그 컴퓨터에
      등록된 프로젝트), 첫 요청을 넣고 "그 컴퓨터에서 시작".
- [ ] 터미널 세션: 탭에 Windows 의 claude 화면이 흐르고, 입력이 그대로 들어간다. 창 크기를 바꾸면 따라 바뀐다.
- [ ] 같은 세션이 Windows 앱에도 탭으로 열려 있을 때 (1.4.10 이상):
      - Mac 에서 입력하면 Mac 창에 꼭 맞고, Windows 탭은 글자가 작아져 화면 전체가 보이며 "원격 컴퓨터의 창 크기로
        표시 중입니다. 입력하면 이 창 크기로 바뀝니다." 가 뜬다.
      - Windows 에서 입력하면 반대로 Windows 창에 맞고, Mac 탭에 "호스트 컴퓨터의 창 크기로 표시 중입니다. ..." 가 뜬다.
      - 어느 쪽에서도 아래쪽(claude 입력칸)이 잘리지 않는다.
- [ ] 대화(chat) 세션도 하나: 메시지를 보내면 답이 온다.
- [ ] 탭을 닫는다 → 다시 새 세션 › office 의 "그 컴퓨터에서 돌고 있는 세션" 에 남아 있고, 열면 같은 화면.
- [ ] 세션이 답을 기다리게 만들면(권한 질문 등) Mac 에 알림이 온다.
- [ ] 등록하지 않은 폴더로는 세션을 시작할 수 없다(목록에 없다).
- [ ] "원격에서 종료" → 확인 창 → Windows 에서 그 세션이 끝난다.

### 1-8. 네트워크 끊김 (명세 "Network loss", 사용자 시나리오 B)

- [ ] 몇 분 걸리는 Job 을 Mac 에서 실행한다.
- [ ] Mac Wi-Fi 를 끈다(또는 덮개를 닫는다).
- [ ] Mac Jobs 화면: "office 이(가) 응답하지 않습니다. 마지막으로 받은 내용입니다. ..." 실패로 표시되지 않는다.
- [ ] Mac CLI: `astera --runtime office jobs list` → `RUNTIME_OFFLINE` (exit 3). 이 컴퓨터의 Job 을 대신 보여 주지 않는다.
- [ ] 그동안 Windows 앱에서 Job 이 계속 돈다.
- [ ] Wi-Fi 를 켠다 → 1분 안에 Mac 화면이 현재 상태로 돌아온다(끊긴 동안 진행된 것까지).
- [ ] 원격 터미널 탭을 연 채로 끊었다 켜면: "Runtime 에 다시 연결하는 중입니다..." 뒤 같은 화면으로 돌아온다.
- [ ] 끊긴 상태에서 Job 을 만들거나 일시정지하면 "Runtime 이 응답하지 않습니다. 그 컴퓨터에서는 아무것도
      바뀌지 않았습니다." 연결 후 목록에 그 동작이 두 번 들어가 있지 않다.

### 1-9. Runtime 재시작 (명세 "Runtime restart")

- [ ] Job 하나를 돌리는 중에 Windows: `astera runtime stop` → `astera host stop`. 돌던 일이 있으면 host stop 이
      exit 6 으로 거절하니, 그때는 Windows 앱을 완전히 종료(트레이에서 끝내기)해서 Host 를 내린다.
- [ ] Mac: office 가 응답 없음으로 바뀐다.
- [ ] Windows: `astera runtime start --listen WIN_IP` → Host 가 다시 뜨고 듣는다.
- [ ] Mac: 다시 붙고, 그 Job 이 Host 가 스스로 복구한 상태로 이어진다(앱을 열지 않아도).
- [ ] 재시작 전에 열려 있던 원격 터미널 세션은 끝난 것으로 보인다(라이브 터미널은 Host 재시작을 넘지 못한다:
      문서가 말하는 정상 동작).
- [ ] 페어링을 다시 하지 않아도 된다(키와 토큰이 유지된다).

### 1-10. 계정 롤링 (선택, 명세 "Account Rolling")

억지로 한도에 걸리게 할 방법이 없으니, 실제로 한도에 가까운 계정이 있을 때만 한다.

- [ ] Windows 에 계정이 둘 이상인 원격 세션을 Mac 에서 시작해 두고, 첫 계정이 한도에 걸리면 Windows 에서
      다음 계정으로 넘어간다. Mac 의 탭이 넘어간 세션을 따라간다.

### 1-11. 보안

- [ ] Windows: `astera runtime revoke --id <macbook-full 의 clientId>` → Mac 의 다음 명령이 `RUNTIME_AUTH_FAILED`,
      열려 있던 원격 탭이 닫힌다.
- [ ] Windows: `astera runtime pair` 로 새 문자열을 만들고, Mac 에서 코드 부분만 틀리게 고쳐 다섯 번 넣는다
      → 다섯 번째 뒤로는 맞는 문자열도 거절된다. Windows `astera runtime status` 의 `burnedCodes` 가 1.
- [ ] Windows: `astera runtime stop` 후 `astera runtime start` (`--listen` 없이, 127.0.0.1) → Mac 에서 `RUNTIME_OFFLINE`.
      확인 뒤 `--listen WIN_IP` 로 다시 켠다.
- [ ] Windows `%APPDATA%\astera\host\host.log` 와 Mac 쪽 로그에 토큰, 페어링 코드, 터미널 출력이 없다.

### 1-12. 재부팅 뒤에도 돌기 (Windows 레시피)

`docs/remote-runtime.md` 의 "Keep it running: OS recipes › Windows" 대로 스크립트와 작업을 등록한다.

- [ ] 작업 스케줄러에 `Astera Runtime` 작업이 생기고, 실행해도 창이 뜨지 않는다.
- [ ] 작업 관리자에서 `astera-host.exe` 를 끝낸다 → 20초 안에 다시 뜨고, Mac 이 다시 붙는다.
- [ ] Windows 를 재부팅하고 로그인한다 → 앱을 열지 않아도 Mac 에서 office 가 응답한다.
- [ ] 끝나면 `Unregister-ScheduledTask -TaskName 'Astera Runtime'` 로 작업을 지우고 스크립트를 지운다.

## 2부. Mac = Runtime, Windows = 컨트롤러

macOS 레시피는 아직 실제 Mac 에서 잰 적이 없어서 이쪽이 더 값지다. 1부를 짧게 반대로 한다.

- [ ] Mac: `astera runtime start --listen MAC_IP`. macOS 방화벽이 켜져 있으면 "들어오는 연결 허용" 을 누른다.
- [ ] Mac: `astera projects add --path ~/work/테스트저장소`, `astera runtime pair --full-control --name windows`
- [ ] Windows 앱 설정 › 원격 Runtime 에서 페어링 → "응답합니다: Astera 1.4.9, darwin".
- [ ] Windows 에서 원격 Job 하나 (1-5): 바뀐 파일과 diff 가 Mac 의 `git diff` 와 같다. 한글 파일 이름 하나 포함.
- [ ] Windows 에서 원격 터미널 세션 하나 (1-7). Mac 의 키체인이 잠겨 있지 않은(로그인한) 상태여야 claude 가 뜬다.
- [ ] Mac 덮개를 닫았다 연다 → Windows 화면이 응답 없음이었다가 돌아온다. 덮개를 닫은 동안 Mac 이 잠들면
      Job 도 멈추는 것은 macOS 의 동작이다(Runtime 은 깨어 있어야 일한다).
- [ ] macOS LaunchAgent 레시피(`docs/remote-runtime.md` › macOS, 아직 아무도 잰 적 없음): plist 의 `you` 를 내
      사용자 이름으로 바꾸고 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/run.astera.runtime.plist`.
      `pgrep -fl "runtime serve"` 에 serve 가 보인다.
- [ ] Host 를 `kill` 로 끝낸다 → 20초 안에 다시 뜨고 Windows 가 다시 붙는다.
- [ ] Mac 을 재시동하고 로그인한다 → 앱을 열지 않아도 Windows 에서 응답한다. 원격 세션의 claude 도 뜬다.
- [ ] 끝나면 `launchctl bootout gui/$(id -u)/run.astera.runtime` 후 plist 를 지운다.

## 3부. 그 컴퓨터의 설정 보기, 기대 확장, 에이전트, 페어링 해제 (Control Plane Phase 12)

1부의 방향 그대로(Windows = Runtime `office`, Mac = 컨트롤러), 전체 제어 페어링으로 한다. 두 컴퓨터 모두 이번
릴리스여야 한다(3-7 만 예외). 사용법은 `docs/remote-runtime.md` 의 "What this computer can see of a Runtime" 과
"Revoke and remove".

### 3-1. 자세히 (Mac 앱)

- [ ] 설정 › 원격 Runtime 에서 office 옆 "자세히" → 식별 정보, 상태, 에이전트, 보호, 확장, Credentials, 비밀 저장소,
      "그 컴퓨터의 Findings: …" 가 보이고, "… 에 읽음" 시각이 있다.
- [ ] Credentials 아래에 "값은 그 컴퓨터에만 있습니다. Astera는 값을 복사하지 않습니다." 가 있고, 이름과 숨김 여부만
      보인다.
- [ ] 화면 어디에도 비밀값, 경로, 명령줄, MCP 서버의 명령이나 URL, Rule 내용이 없다. Windows 앱의 설정 › MCP & Skills
      에는 보이는 MCP 명령과 대조한다.
- [ ] Windows 앱 설정 › 원격 Runtime › 이 컴퓨터의 페어링된 컨트롤러에 "앱 · Astera {버전} · 마지막 연결 …" 이 보인다.

### 3-2. 5분, 새로 고침, 응답 없음

- [ ] 설정을 닫았다가 5분 안에 다시 열고 자세히를 연다 → 읽은 시각이 그대로다. "새로 고침" → 시각이 바뀐다.
- [ ] Windows: `astera runtime stop`. Mac 에서 새로 고침 → 응답하지 않는다는 줄 아래에 마지막으로 읽은 내용과 그 시각이
      그대로 보인다.
- [ ] Mac: `astera runtimes get --id office` → 마지막으로 읽은 내용을 보여 주고, 응답하지 않는다고 말하고, exit 0.
- [ ] Windows: `astera runtime start --listen WIN_IP` 로 다시 켠다. Mac: `astera runtimes ping --id office`
      → 응답하고 버전과 OS 를 말한다.

### 3-3. 기대 확장과 Findings

- [ ] 자세히의 확장에서 Mac 에만 있는 스킬 하나에 체크한다 → 상태가 "그 컴퓨터에 없음".
- [ ] 설정 › Security & Access › Findings 를 연다 → office 와 그 스킬, 읽은 시각을 말하는 Finding 이 하나 있고, 누르면
      office 의 자세히로 간다.
- [ ] 그 Finding 을 무시한다. Windows 에 같은 스킬을 설치하고 Mac 의 스킬 파일을 한 줄 고친 뒤 새로 고침 → 상태가
      "그 컴퓨터와 다름" 으로 바뀌고, Finding 은 무시한 채로 남는다.
- [ ] 고친 줄을 되돌리고 새로 고침 → "같음". Windows 쪽 파일이 CRLF, Mac 쪽이 LF 여도 "같음" 이다.
- [ ] Mac: `astera runtimes expect --id office --add <이 컴퓨터에 없는 id>` → 이 컴퓨터에 없는 id 라며 거절된다.
- [ ] Windows 에 설치되지 않은 확장을 기대 목록에 넣어도, 그 컴퓨터에서 무엇도 설치되지 않는다.

### 3-4. 에이전트는 그 컴퓨터에서도 에이전트

- [ ] Mac 의 Astera 세션 안 터미널(`ASTERA_SESSION` 이 있는 곳)에서 `astera runtimes get --id office`
      → `RUNTIME_PERMISSION_DENIED`, exit 0 이 아니다.
- [ ] 같은 명령을 일반 터미널에서 → 보고서를 읽는다.
- [ ] Mac 의 MCP 클라이언트로 `get_runtime` → 버전과 플랫폼은 있고, 확장이나 프로필 같은 보고서 내용은 없다.

### 3-5. 샌드박스 세션은 읽기만

- [ ] Mac 의 샌드박스 세션 안에서 `astera --runtime office jobs list` → 답한다.
- [ ] 같은 곳에서 `astera --runtime office jobs run --id <jobId>` → "a sandboxed session can only read another
      computer" 로 거절되고 exit 5. Windows 에서 아무것도 시작되지 않는다.

### 3-6. 페어링 해제와 예약 Job

- [ ] Mac 앱 Jobs › Runtime: office 에서 예약 Job 을 하나 만든다.
- [ ] Windows 앱 설정 › 원격 Runtime › 이 컴퓨터에서 Mac 컨트롤러 옆 "해제" → "… 의 페어링을 해제했습니다. 그쪽에서 만들어
      일시 중지한 예약 Job: 1개. …" 가 나온다.
- [ ] Windows 앱 Jobs 에서 그 Job 이 "일시 중지됨: {이름} 에서 만들었고 그 페어링은 해제되었습니다" 로 보인다.
- [ ] Mac 을 다시 페어링하고 그 Job 을 재개하거나 실행해 본다 → 그 컴퓨터의 사람만 재개할 수 있다며 거절된다.
- [ ] Windows 앱에서 재개 → 재개된다.

### 3-7. 이전 버전 Runtime (선택)

이전 릴리스를 깐 컴퓨터가 있을 때만 한다.

- [ ] 그 Runtime 의 자세히 → "이 Runtime은 설정을 알려 줄 수 없습니다. 그 컴퓨터의 Astera를 업데이트하세요."
- [ ] 그래도 확장에서 기대 확장에 체크할 수 있다.
- [ ] Findings 에 두 버전을 말하는 Finding 이 하나 있다.

## 끝나고 정리

- [ ] 양쪽: `astera runtime stop`, 필요 없으면 `astera host stop`.
- [ ] 양쪽: `astera runtime clients` 로 남은 페어링을 보고 `astera runtime revoke --id ...`.
- [ ] 양쪽 앱 설정 › 원격 Runtime 에서 페어링된 Runtime 지우기.
- [ ] Windows 방화벽에 허용 규칙을 손으로 넣었으면 지운다.

## 알아 둘 것

- 같은 LAN 이라 Tailscale 은 필요 없다. 공유기에서 47831 포트를 밖으로 열지 않는다.
- Mac 에서 `RUNTIME_OFFLINE` 인데 Windows `astera runtime status` 는 듣고 있다고 하면 방화벽이다. 관리자
  PowerShell 에서 `New-NetFirewallRule -DisplayName 'Astera Runtime test' -Direction Inbound -Protocol TCP -LocalPort 47831 -Action Allow -Profile Private`
  로 열고, 끝나면 `Remove-NetFirewallRule -DisplayName 'Astera Runtime test'`.
- 오류 코드의 뜻은 `docs/remote-runtime.md` 의 "Error codes" 표.
