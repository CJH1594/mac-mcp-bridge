import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";
import { startOperatorConsole } from "../src/operator-console.js";
import type { LocalControl } from "../src/application-control.js";
import { startHttpFixture } from "./helpers/http-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

async function startTerminalServer(environment: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cokac-terminal-oauth-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({
    MCP_HOST: "127.0.0.1",
    MCP_OAUTH_ENABLED: "true",
    MCP_OAUTH_APPROVAL_MODE: "terminal",
    MCP_PUBLIC_URL: "http://127.0.0.1",
    MCP_OAUTH_STATE_FILE: path.join(directory, "oauth-state.json"),
    MCP_DEFAULT_CWD: directory,
    ...environment,
  });
  const fixture = await startHttpFixture(async (port) => {
    config.port = port;
    return startHttpServer(config, createServices(config));
  });
  cleanup.push(() => fixture.close());
  return {
    config,
    get current() { return fixture.current; },
    restart: () => fixture.restart(),
  };
}

async function beginAuthorization(baseUrl: string, fetcher: typeof fetch) {
  const redirectUri = "https://client.example/oauth/callback";
  const response = await fetcher(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Terminal integration client",
    }),
  });
  expect(response.status).toBe(201);
  const { client_id: clientId } = await response.json() as { client_id: string };
  const verifier = randomBytes(48).toString("base64url");
  const values = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "original-browser-state",
    resource: "http://127.0.0.1/mcp",
    scope: "mcp:tools",
  };
  const authorization = await fetcher(`${baseUrl}/authorize?${new URLSearchParams(values)}`, {
    redirect: "manual",
  });
  expect(authorization.status).toBe(303);
  const approvalPath = authorization.headers.get("location")!;
  const cookieHeader = authorization.headers.get("set-cookie")!;
  const cookie = cookieHeader.split(";")[0]!;
  const page = await fetcher(`${baseUrl}${approvalPath}`, { headers: { cookie } });
  const html = await page.text();
  const number = html.match(/data-request-number="([A-Z0-9-]+)"/)?.[1];
  expect(number).toBeTruthy();
  return { approvalPath, cookie, cookieHeader, number: number!, verifier, values, clientId };
}

async function finishAuthorization(
  baseUrl: string,
  request: Awaited<ReturnType<typeof beginAuthorization>>,
  fetcher: typeof fetch,
) {
  const approved = await fetcher(`${baseUrl}${request.approvalPath}`, {
    headers: { cookie: request.cookie },
    redirect: "manual",
  });
  expect(approved.status).toBe(303);
  const callback = new URL(approved.headers.get("location")!);
  expect(callback.origin + callback.pathname).toBe(request.values.redirect_uri);
  expect(callback.searchParams.get("state")).toBe("original-browser-state");
  return fetcher(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: request.clientId,
      code: callback.searchParams.get("code")!,
      code_verifier: request.verifier,
      redirect_uri: request.values.redirect_uri,
      resource: request.values.resource,
    }),
  });
}

async function decideRequest(control: LocalControl, number: string, approved = true): Promise<void> {
  expect(control.inspectApproval(number)).toBeDefined();
  expect(await control.decideApproval(number, approved)).toBe(true);
}

describe("terminal-approved OAuth", () => {
  it("keeps the disconnected dashboard minimal and opens instructions only with help", async () => {
    const app = await startTerminalServer();
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const terminal = startOperatorConsole(app.current.running.control, { input, output, cwd: app.config.defaultCwd });
    cleanup.push(async () => { terminal.close(); input.destroy(); output.destroy(); });
    await expect.poll(() => transcript).toContain("help 도움말 · Ctrl+C 앱 종료");
    expect(transcript).not.toContain("연결된 기기");
    expect(transcript).not.toContain("reset time");
    transcript = "";
    input.write("help\n");
    await expect.poll(() => transcript).toContain("요청번호를 입력하면 즉시 승인");
    expect(transcript).not.toContain("name 이름");
  });

  it("allows only one approved connection, including before token exchange and after restart", async () => {
    const app = await startTerminalServer();
    const first = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    const second = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    app.current.running.control.inspectApproval(first.number);
    expect(await app.current.running.control.decideApproval(first.number, true)).toBe(true);
    app.current.running.control.inspectApproval(second.number);
    expect(await app.current.running.control.decideApproval(second.number, true)).toBe(false);
    const tokens = await (await finishAuthorization(app.current.baseUrl, first, app.current.fetch)).json() as { access_token: string };
    await app.restart();
    const third = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    app.current.running.control.inspectApproval(third.number);
    expect(await app.current.running.control.decideApproval(third.number, true)).toBe(false);
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(405);
  });

  it("serializes competing approvals and frees the single connection when its time expires", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    app.current.running.control.inspectApproval(request.number);
    expect(await Promise.all([
      app.current.running.control.decideApproval(request.number, true),
      app.current.running.control.decideApproval(request.number, true),
    ])).toEqual([true, false]);
    await finishAuthorization(app.current.baseUrl, request, app.current.fetch);
    now += 6 * 3_600_000;
    expect(await app.current.running.control.resetSessionTime()).toBe(false);
    const next = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    await decideRequest(app.current.running.control, next.number);
    expect((await finishAuthorization(app.current.baseUrl, next, app.current.fetch)).status).toBe(200);
  });

  it("adopts only one existing grant when upgrading an older multi-connection state", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    await decideRequest(app.current.running.control, request.number);
    const tokens = await (await finishAuthorization(app.current.baseUrl, request, app.current.fetch)).json() as { access_token: string };
    await app.current.running.close();
    const state = JSON.parse(await readFile(app.config.oauthStateFile, "utf8"));
    const firstHash = createHash("sha256").update(tokens.access_token).digest("hex");
    const otherToken = "historical-second-device-access-token";
    const otherHash = createHash("sha256").update(otherToken).digest("hex");
    state.clients["historical-second-client"] = {
      ...state.clients[request.clientId], client_id: "historical-second-client", client_name: "Existing second client",
    };
    state.tokens[otherHash] = {
      ...state.tokens[firstHash], clientId: "historical-second-client", grantId: "historical-second-grant",
      sessionExpiresAt: state.approvedSession.expiresAt + 60_000,
    };
    delete state.approvedSession;
    await writeFile(app.config.oauthStateFile, JSON.stringify(state));
    await app.restart();
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(401);
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${otherToken}` },
    })).status).toBe(405);
    expect(await app.current.running.control.getApprovedSession()).toMatchObject({ clientName: "Existing second client" });
  });

  it("shows the approved connection and remaining time in the compact dashboard", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await decideRequest(app.current.running.control, request.number);
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const terminal = startOperatorConsole(app.current.running.control, {
      input, output, cwd: app.config.defaultCwd, endpoint: "http://127.0.0.1/mcp",
    });
    cleanup.push(async () => { terminal.close(); input.destroy(); output.destroy(); });
    await expect.poll(() => transcript).toContain("연결된 기기");
    expect(transcript).not.toContain("Terminal integration client");
    expect(transcript).toContain(`  요청번호    남은 시간\n  ${request.number}  6시간 00분`);
    expect(transcript).toContain(request.number);
    expect(transcript).toContain("6시간 00분");
    expect(transcript).toContain("주소   \"http://127.0.0.1/mcp\"");
    expect(transcript).not.toContain("COKACREMOTE");
    expect(transcript).not.toContain("승인: approve 요청번호");
    now += 3_600_000;
    transcript = "";
    input.write("help\n");
    await expect.poll(() => transcript).toContain("5시간 00분");
  });

  it("resets time only on a local command and refreshes past the old deadline after restart", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    const approvedAt = Date.now();
    let now = approvedAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await decideRequest(app.current.running.control, request.number);
    let tokens = await (await finishAuthorization(app.current.baseUrl, request, app.current.fetch)).json() as {
      access_token: string; refresh_token: string;
    };
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const terminal = startOperatorConsole(app.current.running.control, { input, output, cwd: app.config.defaultCwd });
    cleanup.push(async () => { terminal.close(); input.destroy(); output.destroy(); });
    now += 5 * 3_600_000;
    input.write("reset time\n");
    await expect.poll(() => transcript).toContain("남은 시간을 6시간으로 초기화했습니다");
    expect(await app.current.running.control.getApprovedSession()).toMatchObject({
      number: request.number, expiresAt: approvedAt + 11 * 3_600_000,
    });
    await app.restart();
    now = approvedAt + 6 * 3_600_000 + 60_000;
    const refreshed = await app.current.fetch(`${app.current.baseUrl}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", client_id: request.clientId,
        refresh_token: tokens.refresh_token, resource: request.values.resource,
      }),
    });
    expect(refreshed.status).toBe(200);
    tokens = await refreshed.json() as typeof tokens;
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(405);
    now = approvedAt + 11 * 3_600_000;
    expect(await app.current.running.control.getApprovedSession()).toBeUndefined();
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(401);
  });

  it("enforces inspection before approval through local control itself", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    expect(await app.current.running.control.decideApproval(request.number, true)).toBe(false);
    expect(app.current.running.control.inspectApproval(request.number)).toMatchObject({
      clientId: request.clientId,
    });
    expect(await app.current.running.control.decideApproval(request.number, true)).toBe(true);
    expect((await finishAuthorization(app.current.baseUrl, request, app.current.fetch)).status).toBe(200);
  });

  it("uses the same two-minute deadline for the approval and its browser cookie", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    expect(app.current.running.control.inspectApproval(request.number)?.expiresAt).toBe(1_800_000_120_000);
    expect(request.cookieHeader).toContain("Max-Age=120");
    expect(request.cookieHeader).toContain("HttpOnly");
    expect(request.cookieHeader).toContain("SameSite=Lax");
  });

  it("approves only the most recently inspected request", async () => {
    const app = await startTerminalServer();
    const first = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    const second = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    app.current.running.control.inspectApproval(first.number);
    app.current.running.control.inspectApproval(second.number);
    expect(await app.current.running.control.decideApproval(first.number, true)).toBe(false);
    expect(await app.current.running.control.decideApproval(second.number, true)).toBe(true);
    expect((await finishAuthorization(app.current.baseUrl, second, app.current.fetch)).status).toBe(200);
  });
  it("requires a real local terminal instead of accepting approval commands from a pipe", async () => {
    await expect(promisify(execFile)(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env, MCP_OAUTH_ENABLED: "true", MCP_OAUTH_APPROVAL_MODE: "terminal",
        MCP_AUTH_TOKEN: "", MCP_PUBLIC_URL: "http://127.0.0.1", MCP_PORT: "65535",
        MCP_HOST: "127.0.0.1",
      },
      timeout: 2000,
    })).rejects.toMatchObject({ stderr: expect.stringContaining("Terminal approval requires an interactive terminal") });
  });
  it("refuses a permanent Bearer token that would bypass terminal approval", async () => {
    await expect(startTerminalServer({ MCP_AUTH_TOKEN: "permanent-bypass" }))
      .rejects.toThrow("MCP_AUTH_TOKEN must be empty in terminal approval mode");
  });
  it("returns the original browser to its callback only after local approval", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    expect(app.current.running.control.inspectApproval(request.number)).toMatchObject({
      clientId: request.clientId,
      redirectUri: request.values.redirect_uri,
      scopes: ["mcp:tools"],
    });
    expect(await app.current.running.control.decideApproval(request.number, true)).toBe(true);
    const tokens = await finishAuthorization(app.current.baseUrl, request, app.current.fetch);
    expect(tokens.status).toBe(200);
    expect(await tokens.json()).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      expires_in: 600,
    });
  });

  it("binds a single-use approval to its original cookie and authorization parameters", async () => {
    const app = await startTerminalServer();
    const original = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    const otherBrowser = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    await decideRequest(app.current.running.control, original.number);

    for (const cookie of ["", otherBrowser.cookie, `cokac_approval=${original.number}`]) {
      expect((await app.current.fetch(`${app.current.baseUrl}${original.approvalPath}`, {
        headers: { cookie }, redirect: "manual",
      })).status).toBe(410);
    }
    expect((await app.current.fetch(`${app.current.baseUrl}${original.approvalPath}`, {
      method: "POST", headers: { cookie: original.cookie }, body: "approved=true",
      redirect: "manual",
    })).status).toBe(404);

    const alteredQuery = `${original.approvalPath}?redirect_uri=https://attacker.example/&state=changed&code_challenge=changed`;
    expect((await finishAuthorization(app.current.baseUrl, { ...original, approvalPath: alteredQuery }, app.current.fetch)).status)
      .toBe(200);
    expect(await app.current.running.control.decideApproval(original.number, true)).toBe(false);
    expect((await app.current.fetch(`${app.current.baseUrl}${original.approvalPath}`, {
      headers: { cookie: original.cookie }, redirect: "manual",
    })).status).toBe(410);
  });

  it("cannot approve an expired request and delivers a local rejection to its browser", async () => {
    const app = await startTerminalServer();
    const denied = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    await decideRequest(app.current.running.control, denied.number, false);
    expect((await app.current.fetch(`${app.current.baseUrl}${denied.approvalPath}`, {
      headers: { cookie: denied.cookie }, redirect: "manual",
    })).status).toBe(403);

    const expired = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    const deadline = Date.now() + 120_000;
    vi.spyOn(Date, "now").mockReturnValue(deadline);
    expect(app.current.running.control.inspectApproval(expired.number)).toBeUndefined();
    expect(await app.current.running.control.decideApproval(expired.number, true)).toBe(false);
    expect((await app.current.fetch(`${app.current.baseUrl}${expired.approvalPath}`, {
      headers: { cookie: expired.cookie }, redirect: "manual",
    })).status).toBe(410);
  });

  it("approves a pending request when its number alone is entered", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const terminal = startOperatorConsole(app.current.running.control, {
      input, output, cwd: app.config.defaultCwd,
    });
    cleanup.push(async () => { terminal.close(); input.destroy(); output.destroy(); });

    input.write("INVALID123\n");
    await expect.poll(() => transcript).toContain("승인 대기 중인 요청번호가 없습니다");
    expect((await app.current.fetch(`${app.current.baseUrl}${request.approvalPath}`, {
      headers: { cookie: request.cookie }, redirect: "manual",
    })).status).toBe(200);

    input.write(`${request.number}\n`);
    await expect.poll(() => transcript).toContain(request.number);
    expect(transcript).toContain(app.config.defaultCwd);
    expect(transcript).not.toContain(request.values.redirect_uri);
    expect(transcript).not.toContain(request.clientId);
    expect(transcript).not.toContain("mcp:tools");
    expect(transcript).not.toContain("권한   ");
    expect(transcript).not.toContain("연결을 승인했습니다");
    expect((await finishAuthorization(app.current.baseUrl, request, app.current.fetch)).status).toBe(200);
  });

  it("disconnects and stops work from the terminal, allows a new connection, and keeps old tokens revoked", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    await decideRequest(app.current.running.control, request.number);
    const tokens = await (await finishAuthorization(app.current.baseUrl, request, app.current.fetch)).json() as {
      access_token: string; refresh_token: string;
    };
    const client = await app.current.connectMcp({ authorization: `Bearer ${tokens.access_token}` });
    const job = await client.callTool({
      name: "exec_command", arguments: { cmd: "sleep 60", yieldTimeMs: 0, login: false },
    });
    const { pid } = job.structuredContent as { pid: number };
    expect(() => process.kill(pid, 0)).not.toThrow();
    const pending = await beginAuthorization(app.current.baseUrl, app.current.fetch);

    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const terminal = startOperatorConsole(app.current.running.control, {
      input, output, cwd: app.config.defaultCwd,
    });
    cleanup.push(async () => { terminal.close(); input.destroy(); output.destroy(); });
    input.write("stop\n");
    await expect.poll(() => transcript).toContain("연결을 해제했습니다");
    await expect.poll(() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }).toBe(false);
    expect(app.current.running.control.inspectApproval(pending.number)).toBeUndefined();
    expect(await app.current.running.control.decideApproval(pending.number, true)).toBe(false);
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(401);

    const next = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    await decideRequest(app.current.running.control, next.number);
    const nextTokens = await (await finishAuthorization(app.current.baseUrl, next, app.current.fetch)).json() as { access_token: string };
    const nextClient = await app.current.connectMcp({ authorization: `Bearer ${nextTokens.access_token}` });
    const nextJob = await nextClient.callTool({
      name: "exec_command", arguments: { cmd: "printf reconnected", login: false },
    });
    expect(nextJob.structuredContent).toMatchObject({ stdout: "reconnected", exitCode: 0 });

    await app.restart();
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(401);
    const refresh = await app.current.fetch(`${app.current.baseUrl}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", client_id: request.clientId,
        refresh_token: tokens.refresh_token, resource: request.values.resource,
      }),
    });
    expect(refresh.status).toBe(400);
    expect((await app.current.fetch(`${app.current.baseUrl}/authorize?${new URLSearchParams(request.values)}`, {
      redirect: "manual",
    })).status).toBe(303);
  });

  it("retries durable revocation after storage recovers while access stays blocked", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    await decideRequest(app.current.running.control, request.number);
    const tokens = await (await finishAuthorization(app.current.baseUrl, request, app.current.fetch)).json() as {
      access_token: string;
    };
    const stateFile = app.config.oauthStateFile;
    const backup = `${stateFile}.backup`;
    await rename(stateFile, backup);
    await mkdir(stateFile);
    await expect(app.current.running.control.disconnect()).rejects.toThrow();
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(503);

    await rm(stateFile, { recursive: true });
    await rename(backup, stateFile);
    await expect(app.current.running.control.disconnect()).resolves.toBeUndefined();
    expect((await (await app.current.fetch(`${app.current.baseUrl}/health`)).json()).accessStopped).toBe(false);
    await app.restart();
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(401);
  });

  it("allows repeated and concurrent normal close without revoking an approved session", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    await decideRequest(app.current.running.control, request.number);
    const tokens = await (await finishAuthorization(app.current.baseUrl, request, app.current.fetch)).json() as {
      access_token: string;
    };
    await Promise.all([app.current.running.close(), app.current.running.close()]);
    await app.restart();
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(405);
  });

  it("also stops a child that ignores SIGTERM after its parent exits", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    await decideRequest(app.current.running.control, request.number);
    const tokens = await (await finishAuthorization(app.current.baseUrl, request, app.current.fetch)).json() as { access_token: string };
    const client = await app.current.connectMcp({ authorization: `Bearer ${tokens.access_token}` });
    const job = await client.callTool({
      name: "run_script", arguments: {
        runtime: "node", yieldTimeMs: 1000,
        script: `import { spawn } from "node:child_process";
          const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); process.disconnect(); setInterval(() => {}, 1000);'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
          child.once("message", () => console.log(child.pid));
          setInterval(() => {}, 1000);`,
      },
    });
    const descendantPid = Number((job.structuredContent as { stdout: string }).stdout.trim());
    expect(descendantPid).toBeGreaterThan(0);
    cleanup.push(async () => { try { process.kill(descendantPid, "SIGKILL"); } catch {} });
    await app.current.running.control.stopAccess();
    await expect.poll(() => {
      try { process.kill(descendantPid, 0); return true; } catch { return false; }
    }).toBe(false);
  });

  it("preserves approval across restarts without letting refresh extend the six-hour session", async () => {
    const app = await startTerminalServer();
    const request = await beginAuthorization(app.current.baseUrl, app.current.fetch);
    let now = Date.now();
    const approvedAt = now;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await decideRequest(app.current.running.control, request.number);
    let tokens = await (await finishAuthorization(app.current.baseUrl, request, app.current.fetch)).json() as {
      access_token: string; refresh_token: string; expires_in: number;
    };

    await app.restart();
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(405);

    // Five hours and 59 minutes after the approval, only one minute remains.
    now = approvedAt + 21_540_000;
    const refreshed = await app.current.fetch(`${app.current.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", client_id: request.clientId,
        refresh_token: tokens.refresh_token, resource: request.values.resource,
      }),
    });
    expect(refreshed.status).toBe(200);
    tokens = await refreshed.json() as typeof tokens;
    expect(tokens.expires_in).toBe(60);

    await app.restart();
    now = approvedAt + 21_600_000;
    expect((await app.current.fetch(`${app.current.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(401);
    const expiredRefresh = await app.current.fetch(`${app.current.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", client_id: request.clientId,
        refresh_token: tokens.refresh_token, resource: request.values.resource,
      }),
    });
    expect(expiredRefresh.status).toBe(400);
    expect(await expiredRefresh.json()).toMatchObject({ error: "invalid_grant" });
  });
});
