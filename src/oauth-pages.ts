import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import type { ApprovalSummary } from "./oauth-approval.js";
import { OAUTH_SCOPES } from "./tool-metadata.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hiddenInput(name: string, value: string | undefined): string {
  return value === undefined
    ? ""
    : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

export function renderAuthorizationPage(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  invalidKey: boolean,
): string {
  const clientName = client.client_name || "MCP 클라이언트";
  let redirectHost = params.redirectUri;
  try {
    redirectHost = new URL(params.redirectUri).host;
  } catch {
    // The SDK already validates this URL before calling the provider.
  }
  const fields = [
    hiddenInput("client_id", client.client_id),
    hiddenInput("redirect_uri", params.redirectUri),
    hiddenInput("response_type", "code"),
    hiddenInput("code_challenge", params.codeChallenge),
    hiddenInput("code_challenge_method", "S256"),
    hiddenInput("scope", params.scopes?.join(" ")),
    hiddenInput("state", params.state),
    hiddenInput("resource", params.resource?.href),
  ].join("\n");

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>cokacremote 승인</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #e8ecf5; }
    main { width: min(440px, calc(100vw - 40px)); padding: 28px; border: 1px solid #2a3550; border-radius: 16px; background: #121a2d; box-shadow: 0 20px 70px #0008; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    p { color: #b8c1d8; line-height: 1.55; }
    .warning { padding: 12px; border-radius: 10px; background: #3c2316; color: #ffd8bd; }
    .error { color: #ff9f9f; font-weight: 650; }
    label { display: block; margin: 20px 0 8px; font-weight: 650; }
    input[type=password] { box-sizing: border-box; width: 100%; padding: 12px; border: 1px solid #52617d; border-radius: 9px; background: #0b1020; color: white; font: inherit; }
    button { width: 100%; margin-top: 16px; padding: 12px; border: 0; border-radius: 9px; background: #5b8cff; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    small { display: block; margin-top: 14px; color: #8390aa; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>cokacremote 연결 승인</h1>
    <p><strong>${escapeHtml(clientName)}</strong>이 이 서버의 MCP 도구 사용 권한을 요청했습니다.</p>
    <p class="warning">승인하면 연결된 MCP 클라이언트가 서버 실행 사용자의 OS 권한으로 명령을 실행하고 파일을 변경할 수 있습니다.</p>
    ${invalidKey ? '<p class="error">인증키가 올바르지 않습니다.</p>' : ""}
    <form method="post" action="/authorize" autocomplete="off">
      ${fields}
      <label for="access_key">MCP 인증키</label>
      <input id="access_key" name="access_key" type="password" required autofocus autocomplete="current-password">
      <button type="submit">승인하고 MCP 클라이언트로 돌아가기</button>
    </form>
    <small>콜백 대상: ${escapeHtml(redirectHost)} · 범위: ${escapeHtml(params.scopes?.join(" ") || OAUTH_SCOPES.join(" "))}</small>
  </main>
</body>
</html>`;
}

export function renderTerminalApprovalPage(request: ApprovalSummary): string {
  return `<!doctype html><html lang="ko"><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="refresh" content="2"><title>cokacremote 연결 승인</title>
        <style>body{font-family:system-ui;max-width:40rem;margin:4rem auto;padding:1rem;line-height:1.7}code{font-size:2rem}</style>
        </head><body><h1>Mac 터미널에서 연결을 승인해 주세요</h1>
        <p>요청번호: <code data-request-number="${request.number}">${request.number}</code></p>
        <p>직접 시작한 연결인지 확인하세요. 터미널에 요청번호를 입력하면 즉시 승인됩니다. ${Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000))}초 안에 입력해야 합니다.</p>
        <p>클라이언트: ${escapeHtml(request.clientName)}</p>
        <p>콜백: ${escapeHtml(request.redirectUri)}</p>
        <p>승인되면 이 브라우저가 자동으로 돌아갑니다.</p></body></html>`;
}
