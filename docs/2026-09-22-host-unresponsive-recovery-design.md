# Host 가 답하지 않을 때 회복한다

2026-09-22 오전, 설치본 Astera 에서 세션이 하나도 열리지 않았다. 실행 구성으로 띄운 flowboard 는
노란색에서 멈춘 채 정지도 되지 않았고, 설정 > 정보에는 `연결 안 됨 · the Host accepted the
connection but did not answer` 한 줄만 떴다. 앱을 트레이에서 끄고 다시 켜자 세션은 열렸지만, 그것은
고쳐진 것이 아니라 Host 없이 앱 자체 터미널로 폴백한 것이었고, 멎은 Host 는 그 뒤로도 살아 있었다.

이 문서는 둘을 한다. **이번 원인이 다시는 Host 를 멎게 하지 못하게** 하고, **어떤 이유로든 Host 가
답하지 않으면 사람이 화면에서 알고 버튼 하나로 회복할 수 있게** 한다. 감지는 자동, 끝내는 결정은
사람이 한다(§3).

## 1. 실제로 벌어진 일

| 시각 (KST) | 사실 | 근거 |
|---|---|---|
| 09-21 10:34 | 설치본 1.3.25 시작, Host(pid 78672) 가 `%LOCALAPPDATA%\astera\host-runtime\node-24.15.0\node.exe` 로 뜸 | `host-client.log` |
| 09-22 07:08:36 | 다른 Claude 세션이 CLI 설치 검증 중 `Remove-Item "$env:LOCALAPPDATA\astera" -Recurse -Force` 실행. 목표는 그 안의 `bin` 하나 | 세션 기록 `6451a7ed…jsonl` |
| 07:08:39 | 잠기지 않은 파일이 전부 지워짐: `node_modules\node-pty\lib\**`, `package.json`, `builds\1.3.25\**`. 남은 것은 실행 중이라 잠긴 `node.exe` 와 `conpty.node` 둘 | 폴더 수정 시각, 남은 파일 목록 |
| 07:08:52 | 그 세션이 `node.exe` 가 남은 것을 보고 "무사" 로 판단 | 세션 기록 |
| 10:00:26 | 사용자가 세션을 열자 Host 가 pty 를 만들기 시작. conhost(pid 88904) 는 떴는데 `pty … started` 로그가 없음 | `host.log`, 프로세스 생성 시각 |
| 10:00:26 이후 | Host 메인 스레드가 `KERNELBASE!ConnectNamedPipe` 안에서 정지. 오늘 생성된 스레드 없음 | 네이티브 스택 덤프, 스레드 생성 시각 |
| 같은 시각 | `conpty-…-in` 파이프는 클라이언트 연결됨, `-out` 은 대기 중, `-out-worker` 는 만들어지지 않음 | `WaitNamedPipe` 프로브 |
| 10:03:13 | 앱 재시작. 10초 뒤 `the Host accepted the connection but did not answer`. 그 뒤 로그 없음 | `host-client.log` |
| 10:03:14 | 재설치가 `builds\1.3.25` 만 다시 넣음. `node.exe` 가 있으니 node 폴더는 온전하다고 판단 | `installed (build)` 로그, `runtime.ts:145` |
| 10:05 이후 | 새 세션은 전부 앱(`Astera.exe`)의 자식. Host 없이 폴백 중 | 프로세스 부모 체인 |

**멎은 기구.** node-pty 1.1.0 의 Windows 스폰은 세 단계다(`lib/windowsPtyAgent.js:58~89`).
`startProcess` 가 `-in`/`-out` 명명 파이프와 ConPTY 를 만들고, `ConoutConnection` 이 **워커 스레드**를
파일(`lib/worker/conoutSocketWorker.js`)에서 띄워 `-out` 에 접속시키고, 네이티브 `connect()` 가
`ConnectNamedPipe(hIn); ConnectNamedPipe(hOut);` 를 **동기로** 부른 뒤 셸을 CreateProcess 한다
(`src/win/conpty.cc:381~382`). 주석 그대로 "다른 스레드가 붙어 주는" 전제다. 워커 파일이 없으면 워커는
뜨자마자 죽고, 그 실패 이벤트는 메인 루프로 가는데 메인 루프는 `ConnectNamedPipe(hOut)` 안에 있다.
서로 기다리는 구조라 스스로 풀리지 않는다. conhost 는 클라이언트를 기다리는 정상 대기 상태였고 죄가 없다.

**배제한 것.** 절전·복귀 이벤트 없음. 콘솔 관련 시스템 파일은 8월 13일 이후 바뀌지 않음. Defender
격리 없음. 커밋 메모리 여유 9.5GB. Host 가 메모리 부족이나 시스템 변화로 멎은 것이 아니다.

## 2. 왜 앱이 못 걸렀나: 결함 여섯

### D1. Host 는 pty 하나를 만들다 통째로 멎을 수 있다

`src/host/ptyHost.ts:24` 의 `registry.open` 과 `src/host/registry.ts:108` 의 `this.deps.spawn(...)` 은
동기다. node-pty 안에서 막히면 Host 의 이벤트 루프가 전부 멈춘다. 이번엔 워커 파일 유실이 원인이었지만,
Host 가 답하지 않는 상태는 다른 이유로도 올 수 있고, 그때 앱이 무엇을 하는지가 D2~D4 다.

### D2. 스폰 요청에 응답 기한이 없다

`src/main/host/ptyFactory.ts:36` 의 핸들은 `pty-spawned`/`pty-failed` 가 올 때까지 `pending` 이다.
소켓이 끊기지 않았으니 `onHostGone` 도 불리지 않는다. 세션은 빈 채로, 실행은 노란색으로 영원히 남고,
정지 요청은 귀먹은 Host 로 가며 pid 가 0 이라 강제 종료 대상도 없다. `procFactory.ts:10` 도 같다.

### D3. 인사가 없으면 그 뒤에 아무 일도 없다

`src/main/host/client.ts:334` 는 10초 뒤 `fail()` 하고 `socket.end()` 로 `close` 를 유도해 재시도로
넘기려 한다. 상대가 멎어 있으면 `close` 가 오지 않는다. 로그에 `connection to the Host dropped` 가 한
줄도 없는 것이 그 증거다. 상태는 "연결 안 됨" 에 고정되고 다시는 아무 시도도 하지 않는다.

### D4. 답하지 않는 Host 를 교체할 길이 없다

`src/main/ipc.ts:6950` 은 `sawPeer()` 면 `'unknown'` 을 돌려주고 끝난다. 뭘 들고 있는지 모르니 함부로
죽이지 않겠다는 판단이고 그 자체는 맞다. 그러나 "답하지 않는 Host" 와 "바쁘지만 살아 있는 Host" 를
가르는 수단이 없고, 사람에게 결정을 넘길 자리도 없다. 정보 탭의 "다시 시작" 버튼은 `connected &&
outdated` 일 때만 그려진다(`App.tsx:4174, 4517`). 그리고 pid 를 모른다. 인사를 못 받았으니
`status.pid` 가 null 이다.

### D5. 런타임을 `node.exe` 하나로 판단한다

`src/main/host/runtime.ts:145` `prepareHostRuntime` 은 `exists(exePath)` 만 묻는다. 주석 스스로
"`exists` is the only question asked of it" 이라 적혀 있다. 반쪽 런타임을 온전하다고 믿어 재시작이
복구가 되지 못했고, 그 폴더에서 다음 Host 를 띄웠다면 `require('node-pty')` 에서 죽었을 것이다.

### D6. 공유 폴더를 통째로 지웠다 (원인)

`%LOCALAPPDATA%\astera` 에는 Host 런타임(`host-runtime\`) 과 공개 CLI 셔틀(`bin\`) 이 함께 산다.
검증 중 `bin` 을 지우려다 상위 폴더를 지웠다. 코드 결함이 아니라 작업 규칙이고, 세션 간 메모리에
기록했다. 이 문서의 F6·F7 은 같은 일이 다시 일어나도 Host 가 멎지 않게 하는 안전망이다.

## 3. 결정

1. **감지는 자동, 끝내는 것은 버튼.** Host 를 끝내면 그 Host 가 들고 있던 세션(살아 있는 claude·codex
   프로세스)이 함께 끝난다. 이미 조작할 수 없는 상태라도 끝나는 것은 사실이라, 그 결정은 사람이 한다.
   (사용자 결정, 2026-09-22)
2. **답하지 않음 상태는 Host 가 다시 답하면 스스로 거둔다.** 잠깐 느렸던 Host 를 영구 상태로 만들지 않는다.
3. **회복 전에도 일은 계속된다.** 답하지 않는 동안 새 세션·실행·터미널·대화는 앱 자체 프로세스로 연다.
   그 세션은 앱을 끄면 함께 끝나며, 화면이 그것을 말한다.
4. **프로토콜 번호는 3 을 유지한다.** 새 메시지는 `hello.features` 로 게이트한다. 번호를 올리면 새 앱이
   새 파이프 이름으로 가서 옛 Host 의 터미널이 보이지 않게 된다(`protocol.ts:14~19` 의 이유 그대로).
5. **pid 검증은 플랫폼별로 한다.** Node 에는 다른 프로세스의 실행 파일 경로를 읽는 API 가 없다. Windows
   는 PowerShell `Get-Process`, linux 는 `/proc/<pid>/exe`, mac 은 `ps`. 버튼을 누를 때 한 번이다.
6. **하지 않는 것.** Host 자가 종료, 자동 kill, node-pty 포크, Host 안 스폰의 비동기화(§6).

## 4. 고치는 것

### F1. 상태 모델: 답하지 않음

`HostStatus`(`src/core/types.ts:770`) 에 둘을 더한다.

```ts
/** 접속은 되는데 답이 없다: 심장박동이 끊겼거나(F2), 인사가 없거나(F3), 구형 Host 가 기한을 넘겼다(F4). */
unresponsive: boolean
/** 이 Host 가 도는 런타임 폴더가 반쪽이다. 들고 있는 게 없어지면 교체하고, 그 전엔 알린다(F6). */
runtimeIncomplete: boolean
```

전이는 `HostClient` 한 곳에서 판단한다.

| 에서 | 로 | 계기 |
|---|---|---|
| 연결됨 | 답하지 않음 | ping 3회 연속 무응답(F2). 구형 Host 면 `pty-list`/`proc-list`/스폰 기한 초과(F4) |
| (시작) | 답하지 않음 | 접속은 받았는데 10초 안에 `hello` 가 없음(F3) |
| 답하지 않음 | 연결됨 | 늦은 `pong` 이나 어떤 메시지든 도착 |
| 답하지 않음 | 연결됨(새 Host) | 버튼 → 종료 → 재시작 → 새 `hello`(F5) |

답하지 않음에서 앱이 하는 일.

- **라우팅.** 새 pty 와 proc 을 폴백(앱 자체 node-pty·`nodeProcFactory`) 으로 보낸다. 지금
  `createPtyRouter.use(null)` 은 테스트 밖에 호출자가 없다(`ptyRouter.ts:6~8`). 라우터 전환을
  `onConnect` 의 설치 한 번이 아니라 **상태 변화 구독**(`HostClient.onStatusChange`) 으로 옮겨,
  연결됨이면 Host 팩토리·아니면 폴백이 되게 한다. proc 라우터도 같은 구독을 쓴다.
- **기존 핸들.** Host 위에 있던 핸들은 그대로 둔다. 회복하면 이어지고, 교체하면 기존 `onHostGone`
  경로로 `PTY_LOST_SIGHT_EXIT_CODE` 로 끝난다.
- **재접속 반복 없음.** 소켓은 열어 둔다(늦은 `pong` 을 받기 위해). 새 접속을 반복해 만들지 않는다.
  오늘 확인한 대로 답하지 않는 상대에게 그것은 아무 결과도 내지 못한다.
- **상태 문장.** `problem` 에 이유 한 절을 둔다. `the Host accepted the connection but did not answer`,
  `the Host stopped answering (3 pings unanswered)`, `the Host did not answer a spawn within 20s`.

### F2. 심장박동

프로토콜(`src/core/host/protocol.ts`)에 둘을 더한다. 번호는 3 그대로.

```ts
export const HOST_FEATURE_PING = 'ping'
// ClientMessage
| { t: 'ping'; seq: number }
// HostMessage
| { t: 'pong'; seq: number }
```

- Host(`server.ts`) 는 `ping` 에 같은 `seq` 로 `pong` 을 답하고, `hello.features` 에 `'ping'` 을 넣는다.
- 앱은 `hostSpeaksProcs` 와 같은 꼴의 `hostSpeaksPing(status)` 가 참인 Host 에게만 보낸다. 구형 Host
  는 모르는 메시지를 로그에 적고 무시하므로(`server.ts:176`) `pong` 이 올 수 없고, 보냈다면 무응답으로
  오판한다.
- 상수(`client.ts`): `PING_MS = 5_000`, `PING_MISSES = 3`. 연결 중에만 돌고 타이머는 `unref`. `pong`
  이 하나라도 오면 누락 수를 0 으로 되돌린다. 15초는 실측치가 아니라 초기값이다(§9).

### F3. 시작 시 침묵

`client.ts:334` 의 핸드셰이크 타임아웃에서 `socket.end()` 를 `socket.destroy()` 로 바꾸고 상태를 답하지
않음으로 놓는다. 재시도 루프(`cycle`)로 돌아가지 않는다. 그 소켓은 죽었으니 늦은 `pong` 도 없다.
이 경로의 회복은 F5 의 버튼만이다.

인사가 없으니 pid 를 모른다. Host 가 리슨에 성공한 직후 **pid 파일**을 쓴다.

```
<profileDir>/host/host.pid
{ "pid": 78672, "startedAt": "2026-09-21T01:34:01.303Z", "exe": "C:\\…\\node.exe" }
```

`leave()` 에서 지운다(실패해도 무해: F5 가 실행 파일을 검증한다). 앱은 `status.pid` 가 null 일 때만 읽는다.

### F4. 스폰 기한, 그리고 이유를 터미널에

`ptyFactory.ts`·`procFactory.ts` 의 `pending` 핸들에 `SPAWN_DEADLINE_MS = 20_000` 을 둔다. 기한 안에
`spawned`/`failed` 가 없으면 `onData` 로 한 줄을 흘리고 `end(1)` 한다.

```
[astera] the Host did not answer within 20s — the session was not started
```

`pty-failed`/`proc-failed` 의 `error` 도 지금은 버린다(`ptyFactory.ts:77`). 같은 자리에서 한 줄로 보인 뒤
끝낸다. 사람이 탭에서 이유를 본다. 정지 버튼은 핸들이 끝났으니 기록 정리로 이어진다.

**판정 입력을 갈라 둔다.** `ping` 을 말하는 Host 의 상태는 F2 만 판단한다. 스폰 기한 초과는 그 세션을
끝낼 뿐 Host 를 답하지 않음으로 보내지 않는다. 심장박동에 답하는 Host 가 스폰만 잃는 일은 Host 의 결함이지
무응답이 아니고, 그때 상태를 바꾸면 다음 `pong` 이 바로 되돌려 오판만 남는다. `ping` 이 없는 구형 Host
에는 응답이 있는 요청(`pty-list`·`proc-list` 의 기존 5초 기한, 스폰 기한)의 초과가 유일한 판단 수단이라
그것으로 답하지 않음에 보낸다.

### F5. 교체: 버튼 하나

**보이는 것.** 상태 표시줄에 구형 Host 알림(`status-host-outdated`) 과 같은 자리·같은 색으로 답하지 않음
알림. 정보 탭 Host 줄에 이유 문장과 **다시 시작** 버튼. 버튼 조건을 `connected && outdated` 에서
`(connected && (outdated || runtimeIncomplete)) || unresponsive` 로 넓힌다. 문구는 둘을 말한다: 이 Host
위에 있던 세션 몇 개가 끝나는지(앱이 자기 기록으로 센다. 답하지 않는 Host 에게 물을 수 없다), 새 세션은
지금 앱 안에서 열리고 있고 앱을 끄면 함께 끝난다는 것. 문구는 `src/core/i18n/messages/{en,ko}.ts`.

**누르면(main).**

1. pid: `status.pid` 가 있으면 그것, 없으면 pid 파일(F3).
2. 검증: 그 pid 의 실행 파일 경로를 읽어 기대값과 비교한다. 기대값은 win32 에서 런타임 `node.exe`
   (런타임이 없으면 앱 실행 파일), posix 에서 `process.execPath`. 읽는 법은 §5. 불일치나 프로세스 없음이면
   **끝내지 않고** 로그에 남긴 뒤 4 로 간다(이미 죽었거나 pid 가 재사용된 경우). 불일치인데 주소가 여전히
   답하지 않으면 상태는 다시 답하지 않음이 되고, `problem` 에 "pid N 은 우리 Host 가 아니어서 끝내지
   않았다" 를 적어 화면이 그 사실을 말한다. 그 다음은 사람의 손이다(작업 관리자).
3. 종료: win32 는 `treeKillCommand`(`core/run/kill.ts`, `taskkill /T /F`), posix 는
   `process.kill(pid, 'SIGKILL')`.
4. 기존 `replaceHost`(`ipc.ts:6529`) 를 탄다. `retire` 는 죽은 상대에게 보내니 무해하고, `announce`
   가 Host 위 핸들을 끝내며, `restart` 가 새 Host 를 띄운다. 그 스폰 직전에 F6 의 검사·수리가 낀다.

순수 함수로 뺀다: `hostKillPlan({ platform, pid, expectedExe, actualExe })` → `'kill' | 'skip-gone' |
'skip-mismatch'`. 규칙이 프로세스를 끝내므로 테스트가 닿는 자리에 둔다(`hostReplaceDue` 와 같은 이유).

### F6. 런타임 무결성

- `scripts/host-runtime.mjs` 가 `runtime.json` 에 자기가 쓴 파일 목록을 더한다.
  ```json
  { "node": "24.15.0", "app": "1.3.25",
    "files": { "node": ["node.exe", "node_modules\\node-pty\\lib\\worker\\conoutSocketWorker.js", …],
               "build": ["host.js", "chunks\\stderrTail-….js"] } }
  ```
  목록은 복사가 끝난 뒤 트리를 걸어 만든다. 손으로 유지하는 목록은 빠진다. **구현하며 둘로 나눴다.**
  `builds\<버전>` 아래가 없는 것은 앱 업데이트의 정상 상태이고 node 디렉터리 아래가 없는 것은 손상이라,
  같은 "없음" 이 반대를 뜻하기 때문이다. 실제 크기는 node 48개 + build 3개, 3KB.
- `prepareHostRuntime` 의 판단을 `exists(exePath)` 에서 목록 전부 존재로 바꾼다. node 쪽이 하나라도
  없으면 `rm(nodeDir)` 뒤 기존 staging + rename 으로 다시 깐다. `rm` 이 던지면(잠김: 그 폴더에서 Host 가
  돈다) `{ ready: true, incomplete: true }` 로 돌려준다. 그 Host 에는 그대로 붙는다. build 쪽이 없으면
  그 빌드 폴더만 다시 쓴다 — `host.js` 만 남고 chunks 가 사라진 Host 는 첫 줄에서 죽는데, 기존
  `exists(entryPath)` 검사는 그것을 "설치됨" 으로 읽는다.
- **목록이 비어 있으면 검사하지 않는다.** 설계 초안에서는 빌드 결함이니 `ready: false` 로 보고한다고
  했는데, 그러면 우리 쪽 패키징 실수가 "Host 없는 앱" 이 된다. 잴 수 없는 것은 실패가 아니다 —
  F7 의 `nodePtyMissing` 과 같은 규칙으로 맞췄다.
- 검사 시점을 **Host 를 띄우는 시점마다**로 옮긴다. 지금은 시작 때 한 번이고 결과를 `runtime` 변수에 담아
  `spawnHost` 가 쓴다(`ipc.ts:6390, 6440`). `spawnHost` 가 매번 `prepareHostRuntime` 을 부르게 하면,
  온전할 때는 `existsSync` 몇 번이고 반쪽일 때 다시 까는 일이 정확히 필요한 순간(옛 Host 가 끝나
  `node.exe` 잠금이 풀린 직후)에 일어난다. F5 의 버튼 → 종료 → `restart` → `spawnHost` 순서에 수리가
  끼어든다.
- `runtimeIncomplete` 인 Host 는 구형 Host 와 같은 규칙을 받는다. `hostReplaceDue` 가 `outdated ||
  runtimeIncomplete` 를 보고, 들고 있는 게 없어지면 자동 교체(교체 시 수리가 낌), 그 전엔 배너와 버튼.
  문구만 다르다: "런타임 파일이 손상되어 다음 세션에서 멎을 수 있습니다". 오늘 같은 날이라면 07:08 이후
  첫 세션 종료 시점에 조용히 고쳐졌을 것이다.

### F7. Host 의 스폰 전 자가 점검

`src/host/index.ts:53` 의 spawn 에서 `pty.spawn` 전에 `nodePtyMissing({ platform, exists, libDir })`
를 묻는다. win32 면 `<node-pty lib>/worker/conoutSocketWorker.js` 의 존재, posix 면 항상 null.
`libDir` 은 `path.dirname(require.resolve('node-pty'))`. 없으면 `Error('node-pty is incomplete: <경로>
is missing')` 를 던지고, 그것은 `registry.open` 이 잡아 `pty-failed` 로 답하는 기존 경로다
(`registry.ts:108~112`). 멎는 대신 이유가 나가고, F4 가 그 이유를 터미널에 보인다.

## 5. 플랫폼 차이

| | win32 | linux | darwin |
|---|---|---|---|
| Host 실행 파일 | 런타임 `node.exe` (`runtime.ts`), 없으면 앱 실행 파일 | 앱 실행 파일(`process.execPath`) | 같음 |
| 이번 원인 성립 | 예 | 아니오 (런타임 폴더 없음, node-pty 에 conout 워커 없음) | 아니오 |
| 주소 | 명명 파이프 | `tmpDir` 의 Unix 소켓. 죽은 소켓 파일은 이미 처리(`server.ts:198~206`). 살아서 답 안 하는 Host 는 같은 문제 | 같음 |
| F1~F5 | 공통 | 공통 | 공통 |
| pid 실행 파일 읽기 | `powershell -NoProfile -Command "(Get-Process -Id N).Path"` | `fs.readlink('/proc/N/exe')` | `ps -p N -o comm=` |
| 종료 | `taskkill /pid N /T /F` | `process.kill(N, 'SIGKILL')` | 같음 |
| F6 런타임 무결성 | 적용 | 해당 없음 (`hostRuntimeBase` 가 null) | 해당 없음 |
| F7 자가 점검 | 워커 파일 | 아무 것도 안 함 | 아무 것도 안 함 |

경로 비교는 win32 에서 대소문자를 무시하고, 양쪽 모두 `path.resolve` 로 정규화한 뒤 비교한다.
`executableOf(platform, pid, run)` 은 `address.ts` 처럼 platform 을 인자로 받는 순수 함수로 두어 세 플랫폼
테스트가 한 파일에서 돈다.

## 6. 고치지 않는 것

- **Host 자가 종료.** Host 안의 감시 스레드가 메인 루프 정지를 보고 스스로 나가는 것. 사람이 결정한다는
  §3-1 과 어긋나고, 메인 루프가 멎었는지는 결국 메인 루프의 신호로만 알 수 있어 F2 와 정보량이 같다.
- **자동 kill.** 답하지 않음을 앱이 알아서 끝내는 것. 같은 이유.
- **node-pty 포크.** `ConnectNamedPipe` 에 기한을 넣거나 워커 실패를 스폰 실패로 바꾸는 것. 상류에 낼
  가치는 있지만 이 문서의 범위 밖이다. F7 이 그 앞에서 막는다.
- **Host 안 스폰의 비동기화.** pty 스폰을 워커나 자식 프로세스로 옮기는 것. 기한과 교체로 충분하고,
  손대는 범위가 크다.
- **폴백으로 열린 세션을 새 Host 로 옮기는 것.** pty 는 만든 프로세스에 묶인다. 옮길 수 없고, 앱을 끄면
  끝난다는 것을 화면이 말한다.

## 7. 테스트

**단위 (vitest, 기존 fake 재사용).**

- `client.test.ts`: 접속만 받고 침묵하는 peer → `unresponsive`, `destroy` 호출, 재접속 없음. `pong` 3회
  누락 → `unresponsive`. 그 뒤 `pong` → `connected`. `features` 에 `ping` 없는 Host 에는 `ping` 을
  보내지 않음. `onStatusChange` 가 전이마다 한 번 불림.
- `ptyFactory.test.ts`·`procFactory.test.ts`(fake timers): `pending` 20초 → `onData` 한 줄 + `end(1)`.
  `pty-failed` 의 `error` 가 `onData` 로 보임. `pong` 가능 Host 에서는 스폰 기한이 상태를 바꾸지 않음.
- `ptyRouter.test.ts`: 상태 구독으로 팩토리가 오가는지.
- `runtime.test.ts`: node 목록 중 하나 없음 → `rm` 후 재설치. `rm` 이 던짐 → `incomplete`. build 목록 중
  하나 없음 → 빌드 폴더만 다시. 전부 있음 → 아무 것도 안 함. 첫 설치와 앱 업데이트를 손상으로 읽지 않음.
  목록이 비면 검사를 건너뜀.
- `server.test.ts`: `ping` → 같은 `seq` 의 `pong`. `hello.features` 에 `ping`. 리슨 후 pid 파일, `leave`
  후 삭제.
- Host 자가 점검: win32 + 없음 → 예외, 있음 → 통과, posix → 통과.
- `executableOf`: 세 플랫폼 출력 파싱(PowerShell 줄, readlink 결과, `ps` 출력), 실패 → null.
- `hostKillPlan`: 일치 → `kill`, 불일치 → `skip-mismatch`, null → `skip-gone`.
- `hostReplaceDue`: `runtimeIncomplete` 가 `outdated` 와 같은 효과.

**실제 앱 (dev 앱, CDP. 절차는 메모리 `astera-dev-run-cdp`).**

1. 프로필 주소에 **접속만 받고 침묵하는 가짜 Host** 를 먼저 띄운 뒤 앱 시작. 배너, 정보 탭 문장, 버튼이
   보이고 새 세션이 앱 안에서 열리는지 화면으로 확인한다.
2. 버튼 → 가짜가 끝나고 진짜 Host 가 뜨는지. 가짜는 앱 실행 파일(`ELECTRON_RUN_AS_NODE`) 로 돌려야 pid
   검증을 통과한다. `node` 로 돌린 가짜는 검증이 막아야 하고, 그것도 확인 항목이다.
3. **인사 뒤 침묵하는 가짜**(hello 만 답하고 `pong` 없음)로 F2 경로. 15초 뒤 배너.
4. 정상 Host 에서 세션을 여러 개 열고 닫으며 `ping` 이 로그에 소음을 내지 않는지.

## 8. 따라 고칠 주석과 문서

- `ptyRouter.ts:6~8` "use(null) 은 테스트 밖 호출자가 없다": F1 이 호출자가 된다.
- `client.ts:329~333` `socket.end()` 로 `close` 를 유도한다는 설명: F3 으로 거짓이 된다.
- `ipc.ts:6917~6919` 라우터가 전환되지 않는 틈에 대한 주석: F1 의 상태 구독으로 닫힌다.
- `ipc.ts:6954~6957` "what it is still running is unknown, so no worker is written off": 판단은 유지되되
  그 다음에 F1 의 상태와 F5 의 버튼이 있다는 것을 적는다.
- `runtime.ts:126~130` "`exists` is the only question asked of it": F6 으로 바뀐다.
- `types.ts:780` 의 `docs/superpowers/specs/2026-09-14-host-replacement-design.md` 경로는 저장소에 없다.
  이 문서를 가리키게 고친다.

## 9. 남기는 것

- `PING_MS`·`PING_MISSES`·`SPAWN_DEADLINE_MS` 는 초기값이다. 실제 사용에서 느린 디스크의 첫 스폰이나 절전
  복귀 직후에 오판이 나오면 그때 잰 값으로 고친다.
- `runtimeIncomplete` 인 Host 를 자동 교체하는 것은 "들고 있는 게 없을 때" 만이다. 하루 종일 세션이
  살아 있으면 배너가 하루 종일 떠 있다. 그것은 의도다: 사람이 결정한다.
- 상류(node-pty)에 워커 실패를 스폰 실패로 바꾸는 수정을 제안할 가치가 있다. 별건이다.
