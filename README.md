# Mac MCP Bridge

ChatGPT를 비롯한 MCP 클라이언트에서 Mac이나 Linux 호스트의 명령 실행, 파일 작업, 이미지 조회를 할 수 있게 연결하는 도구입니다. Mac에서는 터미널에서 연결을 승인하고, 남은 연결 시간을 확인하거나 연결을 해제할 수 있습니다.

이 프로젝트는 **[kstost/cokacremote](https://github.com/kstost/cokacremote)를 바탕으로 일부 기능과 사용 흐름을 변용한 프로젝트**입니다. 원본의 실행·파일 관리 기능에 터미널 OAuth 승인, 단일 연결 제한, 간단한 대시보드, macOS 화면 캡처, 원본 PNG 반환, 출력량 제어를 추가했습니다. 원본 기여자의 MIT 저작권 고지를 [LICENSE](LICENSE)에 보존했습니다.

[영문 참고 문서](README.en.md)

## 어떤 일을 할 수 있나요?

- 셸 명령과 스크립트 실행, 프로젝트 빌드 및 테스트
- 파일 읽기·쓰기·수정·이동·삭제와 업로드·다운로드
- 오래 실행되는 명령의 출력 조회, 입력 전달, 종료
- PNG 이미지를 크기 변경이나 재압축 없이 반환
- Mac의 전체 화면, 특정 창, 지정 영역 캡처

MCP(Model Context Protocol)는 AI 클라이언트가 외부 프로그램의 도구를 호출하는 규약입니다. 이 서버는 총 **23개 도구**를 제공합니다.

```text
ChatGPT 또는 MCP 클라이언트
          │ HTTPS / MCP
          ▼
    Mac MCP Bridge
          │
          ▼
    Mac 또는 Linux 호스트
    ├─ 명령·스크립트 실행
    ├─ 파일 읽기·쓰기
    └─ 이미지 조회·화면 캡처
```

> **접근 권한 안내:** 승인된 클라이언트는 서버를 실행한 OS 사용자의 권한으로 작업합니다. 작업 폴더는 시작 위치이며 접근 제한이 아닙니다. 샌드박스나 명령별 승인 기능은 없고, 파일 삭제 및 임의 명령 실행이 가능합니다. 신뢰하는 클라이언트에만 연결을 승인하세요.

## Mac에서 시작하기

### 준비 사항

- Node.js 22 이상과 npm
- ngrok 설치 및 본인 계정 인증, 사용할 HTTPS 도메인
- Git
- 화면 캡처를 사용하려면 macOS 14 이상, Xcode Command Line Tools, 서버를 실행하는 앱의 화면 기록 권한

### 설치와 실행

```bash
git clone https://github.com/CJH1594/mac-mcp-bridge.git
cd mac-mcp-bridge
npm ci
./start.sh
```

실행 과정에서 다음을 입력합니다.

1. 본인의 ngrok HTTPS 주소: 예를 들어 `https://your-domain.ngrok-free.dev`
2. 작업 폴더: 처음 실행할 때의 기본값은 홈 폴더입니다.

`start.sh`는 서버를 빌드하고 ngrok 터널을 연 다음 승인 대시보드를 표시합니다. MCP 클라이언트에는 화면에 표시되는 `/mcp` 주소를 등록하세요.

주소를 환경 변수로 지정할 수도 있습니다.

```bash
MCP_PUBLIC_URL=https://your-domain.ngrok-free.dev ./start.sh
```

이전에 선택한 작업 폴더를 다시 사용하려면 다음과 같이 실행합니다. ngrok 주소는 환경 변수로 제공하지 않으면 다시 입력해야 합니다.

```bash
MCP_PUBLIC_URL=https://your-domain.ngrok-free.dev ./start.sh --reuse-last
```

### 연결 승인

1. MCP 클라이언트에서 OAuth 연결을 시작합니다.
2. 브라우저 승인 페이지에서 클라이언트 이름과 콜백 주소를 확인합니다. 이름은 클라이언트가 직접 보낸 값이며 실제 기기 신원을 보증하지 않습니다.
3. 브라우저에 표시된 요청번호를 **2분 안에 Mac 터미널에 입력**합니다.
4. 요청번호를 입력하면 즉시 승인되고, 원래 브라우저가 OAuth 콜백으로 돌아갑니다.

별도의 `approve` 명령은 필요하지 않습니다. 거절하려면 `deny 요청번호`를 입력합니다.

### 대시보드 명령

| 입력 | 동작 |
|---|---|
| 요청번호 | 해당 연결을 즉시 승인 |
| `deny 요청번호` | 대기 중인 연결 거절 |
| `stop` | 연결 권한 폐기, 실행 작업 정리 후 새 연결 대기 |
| `reset time` | 유효한 연결의 남은 시간을 현재 시점부터 6시간으로 초기화 |
| `help` | 도움말 표시 |
| Enter | 도움말 닫기 |
| Ctrl+C | 앱 종료 및 실행 작업 정리. 발급된 연결 권한은 유지 |

연결 후에는 요청번호와 남은 시간만 표시합니다. 시간은 30초마다 갱신하며, 실제 온라인 여부가 아니라 **승인 유효시간**을 뜻합니다.

### 연결 제한과 재시작

- 터미널 모드에서는 승인된 연결을 **한 개만** 허용합니다. 다른 클라이언트로 바꾸려면 먼저 `stop`을 입력하세요.
- 최초 승인 유효시간은 기본 6시간입니다. 토큰 갱신, 서버 재시작, 일시적인 터널 끊김으로 시간이 늘어나지 않습니다.
- `reset time`을 직접 입력한 경우에만 유효한 연결의 기한을 다시 6시간으로 설정합니다. 만료된 연결은 새로 승인해야 합니다.
- 일반 종료 후 재시작하면 기존 승인과 클라이언트 등록은 유지됩니다. 실행 중이던 명령과 메모리에 보관하던 출력은 복구되지 않습니다.
- `stop`으로 폐기한 토큰은 재시작 후에도 사용할 수 없습니다. 정리에 실패하면 접근을 차단한 상태로 오류를 표시하며, 원인을 해결한 뒤 `stop`으로 재시도할 수 있습니다.
- 브라우저 승인이 끝나기 전에 서버를 재시작했다면 예약된 승인만 남을 수 있습니다. `stop` 후 연결을 다시 시작하세요.
- 연결 제한은 OAuth 승인 단위입니다. 같은 토큰을 다른 물리적 기기에 복사한 경우까지 식별하는 기능은 아닙니다.

## 제공하는 도구

| 분류 | 도구 |
|---|---|
| 명령·프로세스 | `exec_command`, `run_script`, `write_stdin`, `read_process`, `terminate_process`, `list_processes` |
| 파일 조회 | `list_directory`, `stat_path`, `read_file`, `download_file`, `hash_file` |
| 파일 변경 | `write_file`, `replace_in_file`, `apply_patch`, `upload_file`, `make_directory`, `copy_path`, `move_path`, `remove_path`, `chmod_path` |
| 이미지·화면 | `view_image`, `list_capture_targets`, `capture_screenshot` |

상대 경로는 `MCP_DEFAULT_CWD`를 기준으로 해석합니다. 절대 경로와 `~/...`도 사용할 수 있습니다. `remove_path`는 휴지통을 거치지 않고 삭제하며, `apply_patch`는 호스트의 `git apply --unsafe-paths`를 사용합니다.

### 이미지와 화면 캡처

`view_image`는 PNG를 검증한 뒤 원본 바이트를 MCP 이미지 콘텐츠로 반환합니다. 파일 크기와 픽셀 수 제한을 적용하지만 크기를 줄이거나 재압축하지 않습니다.

먼저 `list_capture_targets`로 디스플레이·창 ID를 확인한 뒤, `capture_screenshot`의 `target`에 다음 중 하나를 전달합니다.

```json
{"kind":"display","displayId":1}
```

```json
{"kind":"window","windowId":123}
```

```json
{"kind":"region","displayId":1,"x":0,"y":0,"width":320,"height":240}
```

ID는 예시입니다. 영역 좌표와 크기는 선택한 디스플레이의 왼쪽 위를 기준으로 한 논리 좌표이고, 반환되는 이미지 크기는 픽셀 단위입니다.

내장 캡처 도구는 macOS 14 이상에서 동작합니다. `npm run build`가 Swift 도우미를 컴파일하며, 실제 캡처에는 로그인된 데스크톱 세션과 화면 기록 권한이 필요합니다. 권한이 없으면 오류를 반환하며 캡처 요청이 권한 팝업을 자동으로 띄우지는 않습니다.

### 출력량과 이어 읽기

프로세스 출력과 파일 읽기는 기본 **32 KiB**씩 반환합니다.

- 파일은 반환된 `nextOffset`을 다음 요청의 `offset`으로 전달합니다.
- 프로세스는 반환된 `nextSeq`를 다음 `read_process` 요청의 `afterSeq`로 전달합니다.
- `outputFormat: "compact"`는 중복된 `stdout`·`stderr`를 생략하고 합쳐진 `output`을 제공합니다.
- `read_process`의 `view: "tail"`은 마지막 부분, `view: "failure"`는 최근 표준 오류와 마지막 문맥을 우선 반환합니다. 이 두 보기에서는 이어 읽기 커서를 진행시키지 않습니다.
- `cursorGap: true`이면 이전 출력 일부가 보관 제한으로 제거된 상태입니다.

UTF-8 파일은 문자 중간에서 끊지 않으므로 요청 크기를 최대 3바이트 초과할 수 있습니다. 잘못된 UTF-8은 오류로 처리하며, 바이너리 파일은 `encoding: "base64"`로 읽습니다.

## Linux에서 실행하기

Node.js 22 이상, npm, Git이 필요합니다. Python 스크립트를 실행하려면 Python 3도 설치해야 합니다.

```bash
git clone https://github.com/CJH1594/mac-mcp-bridge.git
cd mac-mcp-bridge
npm ci
npm run build

export MCP_HOST=127.0.0.1
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
export MCP_DEFAULT_CWD="$HOME"
npm start
```

이 예시는 로컬 서버를 정적 Bearer 인증으로 실행합니다. 요청에 `Authorization: Bearer <MCP_AUTH_TOKEN>` 헤더가 필요합니다. 외부 연결에는 HTTPS 주소와 해당 인증 방식을 지원하는 클라이언트가 필요합니다.

상시 운영용 systemd·Nginx 설정은 [deploy](deploy/)에 있습니다. 배포 절차와 프록시 설정은 [영문 배포 안내](README.en.md#vpsec2-deployment)를 참고하세요. 소스만 복사해 빌드할 때는 빌드 스크립트가 있는 `scripts/` 폴더도 포함해야 합니다.

Docker와 Cloudflare Tunnel을 사용하는 구성은 [tunneling 안내](tunneling/README.md)를 참고하세요. Linux에서는 기본 macOS 화면 캡처 기능을 사용할 수 없습니다.

## 인증과 MCP 연결

서버는 정적 Bearer 토큰과 OAuth 인증을 지원합니다. OAuth는 동적 클라이언트 등록(DCR), Authorization Code + PKCE(S256), 리소스 검증, 갱신 토큰 회전과 재사용 탐지, 토큰 폐기를 제공합니다.

| 모드 | 용도 |
|---|---|
| `MCP_OAUTH_APPROVAL_MODE=terminal` | 로컬 터미널에서 요청번호로 승인. `start.sh`가 사용하는 방식 |
| `MCP_OAUTH_APPROVAL_MODE=key` | 브라우저에서 승인 키를 입력. 터미널 없이 운영하는 서버용 기본 모드 |

터미널 모드는 대화형 터미널이 필요하고, 정적 토큰으로 승인을 우회하지 못하도록 `MCP_AUTH_TOKEN` 설정을 허용하지 않습니다. 승인 키 방식은 `MCP_OAUTH_APPROVAL_KEY`를 사용합니다. 등록 정보와 토큰 해시는 `MCP_OAUTH_STATE_FILE`에 저장되며 파일 권한은 `600`입니다.

ChatGPT 등 OAuth 지원 MCP 클라이언트에는 공개 주소의 `/mcp` 엔드포인트를 등록합니다. 등록 방식을 선택할 수 있다면 DCR을 사용하고, 요청 범위는 `mcp:tools`입니다. 이 서버는 DCR을 제공하며 CIMD나 OIDC는 제공하지 않습니다. 클라이언트의 연결 메뉴와 사용 가능한 도구는 계정·워크스페이스 정책에 따라 달라질 수 있습니다.

| HTTP 경로 | 역할 |
|---|---|
| `/mcp` | MCP 요청 처리 |
| `/health` | 서버 상태 확인 |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | 리소스 메타데이터 |
| `/.well-known/oauth-authorization-server` | 인증 서버 메타데이터 |
| `/register` | 클라이언트 등록 |
| `/authorize` | 연결 승인 시작 |
| `/oauth/approval/:id` | 터미널 승인 상태 확인과 원래 브라우저의 콜백 전달 |
| `/token` | 인증 코드·갱신 토큰 교환 |
| `/revoke` | 토큰 폐기 |

인증되지 않은 서버를 인터넷에 공개하면 주소를 아는 사람이 호스트 권한으로 도구를 사용할 수 있습니다. `MCP_ALLOW_NO_AUTH`는 인증을 담당하는 별도 게이트웨이 등 보호 수단이 있는 배포에서만 사용하세요.

## 주요 설정

전체 설정 예시는 [.env.example](.env.example), 운영 환경 예시는 [deploy/remote-dev-mcp.env.example](deploy/remote-dev-mcp.env.example)에 있습니다. `.env` 예시는 직접 환경 변수로 적용하거나 서비스의 환경 파일로 사용해야 합니다.

| 환경 변수 | 기본값 또는 의미 |
|---|---|
| `MCP_HOST`, `MCP_PORT` | 직접 실행 기본값은 `0.0.0.0`, `3000`. `start.sh`는 `127.0.0.1` 사용 |
| `MCP_ENDPOINT` | `/mcp` |
| `MCP_PUBLIC_URL` | `/mcp`를 제외한 외부 HTTPS 주소 |
| `MCP_ALLOWED_HOSTS` | 허용할 Host 이름 목록, 쉼표로 구분 |
| `MCP_TRUST_PROXY_HOPS` | 기본 `0`. 실제 신뢰할 프록시 개수와 일치시켜야 함 |
| `MCP_AUTH_TOKEN` | 정적 Bearer 토큰 |
| `MCP_OAUTH_ENABLED` | 기본 `false`. `start.sh`는 `true` |
| `MCP_OAUTH_APPROVAL_MODE` | 기본 `key`. `start.sh`는 `terminal` |
| `MCP_OAUTH_APPROVAL_KEY` | 브라우저 승인 키 |
| `MCP_OAUTH_ISSUER`, `MCP_OAUTH_RESOURCE` | 인증 서버 주소와 MCP 리소스 주소 |
| `MCP_OAUTH_STATE_FILE` | OAuth 등록 정보와 토큰 해시 저장 경로 |
| `MCP_OAUTH_SESSION_TTL_SECONDS` | 승인 유효시간, 기본 `21600`초 |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | 터미널 모드는 기본 `600`초, 그 외 `3600`초. 승인 기한을 넘지 않음 |
| `MCP_DEFAULT_CWD`, `MCP_DEFAULT_SHELL` | 기본 작업 폴더와 셸 |
| `MCP_DEFAULT_OUTPUT_BYTES`, `MCP_DEFAULT_FILE_READ_BYTES` | 기본 출력·파일 읽기 크기, 각각 `32768`바이트 |
| `MCP_MAX_OUTPUT_BYTES`, `MCP_MAX_FILE_CHUNK_BYTES` | 요청당 최대 출력·파일 읽기 크기, 각각 `1048576`바이트 |
| `MCP_MAX_RETAINED_PROCESS_OUTPUT_BYTES` | 프로세스별 보관 출력, 기본 `4194304`바이트 |
| `MCP_PROCESS_RETENTION_MS` | 종료된 프로세스 기록 보관 시간, 기본 `3600000`밀리초 |
| `MCP_MAX_IMAGE_BYTES`, `MCP_MAX_IMAGE_PIXELS` | PNG 제한, 기본 `8388608`바이트와 `16777216`픽셀 |
| `MCP_SCREEN_CAPTURE_TIMEOUT_MS` | 캡처 제한 시간, 기본 `15000`밀리초 |
| `MCP_SCREEN_CAPTURE_HELPER` | 호환되는 사용자 지정 캡처 실행 파일 경로 |

## 상태 확인과 문제 해결

```bash
curl http://127.0.0.1:3000/health
curl https://your-domain.ngrok-free.dev/health
```

`start.sh`로 실행하면 서버 로그는 `~/.cokacremote/server.log`에 저장됩니다. 로그와 승인 입력을 분리해 ngrok 화면이나 요청 로그가 대시보드를 가리지 않도록 구성했습니다.

| 상태 | 의미와 확인 방법 |
|---|---|
| `activeMcpSessions: 0` | 독립적인 HTTP 요청 방식이므로 정상 |
| `activeMcpRequests` | 현재 처리 중인 MCP HTTP 요청 수 |
| `managedProcesses` | 실행 중인 작업과 출력 조회를 위해 보관 중인 종료 작업을 모두 포함. 실제 실행 여부는 `list_processes`의 `running` 확인 |
| `401 Unauthorized` | 토큰이 없거나 유효하지 않음 |
| 인증된 `GET /mcp` 또는 `DELETE /mcp`의 `405` | 정상. 도구 호출은 `POST /mcp` 사용 |
| `403 Host header is not allowed` | `MCP_ALLOWED_HOSTS` 설정 확인 |
| 승인 대기 중인 요청번호가 없음 | 잘못 입력했거나 2분 유효시간이 지남. 클라이언트에서 새 연결 시작 |
| 이미 승인된 연결이 있음 | `stop`으로 기존 연결 해제 후 새 연결 승인 |
| 캡처 권한 오류 | 서버를 실행하는 앱의 macOS 화면 기록 권한 확인 |

일반 재시작은 OAuth 승인을 유지하지만 실행 작업과 메모리 출력은 유지하지 않습니다. 연결 해제나 프로세스 종료는 이미 수행한 파일 변경을 되돌리지 않습니다.

## 개발과 검증

```bash
npm run typecheck
npm test
npm run build
```

테스트·실행 fixture·진단 코드는 모두 `test/`에 있습니다. 자동 테스트는 실제 MCP 클라이언트를 사용해 인증, 도구 호출, 파일 처리, 프로세스 정리, 재시작, 출력 제한 등을 확인합니다. 화면 캡처 자동 테스트에서는 별도의 실행 fixture를 사용합니다.

실제 Mac 화면 캡처 점검:

```bash
TMPDIR=/tmp node --import tsx test/diagnostics/screen-capture-smoke.mjs --capture
```

실행 중인 서버와 외부 ngrok 경로의 OAuth·도구 호출 점검:

```bash
node --import tsx test/diagnostics/live-mcp-smoke.mjs https://your-domain.ngrok-free.dev --capture
```

진단 프로그램이 표시한 요청번호를 실제 서버 터미널에 입력해야 합니다. 테스트 후 해당 연결의 토큰과 임시 파일을 정리합니다. 기존 승인 연결이 있다면 먼저 해제해야 하며, 진단 프로그램이 기존 연결을 임의로 끊지는 않습니다.

추가 진단 방법은 [test/diagnostics/README.md](test/diagnostics/README.md), 용어 정의는 [GLOSSARY.md](GLOSSARY.md)를 참고하세요.

## 프로젝트 구조

| 경로 | 역할 |
|---|---|
| `start.sh` | Mac용 시작 스크립트와 ngrok 실행 |
| `src/operator-console.ts` | 터미널 대시보드와 승인·해제 명령 |
| `src/application-control.ts` | 접근 허용, 연결 해제, 종료 흐름 |
| `src/http-server.ts`, `src/mcp-server.ts` | HTTP 요청 처리와 MCP 도구 등록 |
| `src/oauth*.ts` | OAuth 승인, 토큰, 상태 저장 |
| `src/host-execution.ts`, `src/process-manager.ts` | 명령 실행과 프로세스 수명 관리 |
| `src/file-service.ts`, `src/file-tools.ts` | 파일 작업 |
| `src/image*.ts`, `src/screen*.ts` | 이미지 반환과 화면 캡처 |
| `src/native/screen-capture.swift` | macOS 네이티브 캡처 도우미 |
| `scripts/build-native.mjs` | 네이티브 도우미 빌드 |
| `deploy/`, `tunneling/` | 서버 배포 예시 |
| `test/` | 테스트·fixture·진단 코드 |

내부 서비스 이름과 일부 경로의 `cokacremote`, `remote-dev-mcp` 표기는 원본과의 호환성을 위해 유지하고 있습니다.

## 출처와 라이선스

- 원본 프로젝트: [kstost/cokacremote](https://github.com/kstost/cokacremote)
- 이 변용 프로젝트: [CJH1594/mac-mcp-bridge](https://github.com/CJH1594/mac-mcp-bridge)
- 라이선스: [MIT](LICENSE)

소프트웨어는 보증 없이 제공됩니다. 구체적인 권리와 면책 조건은 원문 [LICENSE](LICENSE)를 확인하세요.
