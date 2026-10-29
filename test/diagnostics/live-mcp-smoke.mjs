import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pixel } from "../fixtures/pixel.ts";

// Opt-in: exercises an already running server. Approval remains a human terminal action.
// Secrets stay in memory; never print cookies, codes, tokens, or image payloads.
const publicUrl = process.argv.find((arg) => arg.startsWith("https://"));
if (!publicUrl) throw new Error("Provide the public HTTPS URL as an argument");
const external = new URL(publicUrl);
const local = new URL("http://127.0.0.1:3000");
const headers = { "ngrok-skip-browser-warning": "1" };
let clientId;
let accessToken;
let temporaryDirectory;
const clients = [];

async function request(url, options = {}) {
  return fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(15_000) });
}

function pass(label) { console.log(`PASS ${label}`); }

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name}: ${result.structuredContent?.code || result.structuredContent?.error || "tool failed"}`);
  return result;
}

try {
  for (const base of [local, external]) {
    const health = await request(new URL("/health", base));
    assert.equal(health.status, 200);
    assert.equal((await health.json()).accessStopped, false);
    const unauthorized = await request(new URL("/mcp", base), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
    pass(`${base.host}: health and unauthenticated access rejection`);
  }
  const metadataResponse = await request(new URL("/.well-known/oauth-protected-resource/mcp", external));
  assert.equal(metadataResponse.status, 200);
  const { resource } = await metadataResponse.json();
  assert.equal(resource, new URL("/mcp", external).href);
  const redirectUri = "http://127.0.0.1:39817/mcp-live-smoke-callback";
  const registered = await request(new URL("/register", external), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      client_name: "MCP 실제 동작 테스트",
    }),
  });
  assert.equal(registered.status, 201);
  clientId = (await registered.json()).client_id;
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const authorize = new URL("/authorize", external);
  authorize.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", scope: "mcp:tools", resource, state,
  });
  const authorization = await request(authorize, { redirect: "manual" });
  assert.equal(authorization.status, 303);
  const approval = new URL(authorization.headers.get("location"), external);
  assert.equal(approval.origin, external.origin);
  const cookie = authorization.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const page = await request(approval, { headers: { cookie }, redirect: "manual" });
  assert.equal(page.status, 200);
  const number = (await page.text()).match(/data-request-number="([A-Z0-9-]+)"/)?.[1];
  assert(number);
  console.log(`APPROVAL_REQUIRED ${number}`);
  console.log(`Terminal: enter ${number} to approve (within 2 minutes)`);
  let callback;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await delay(1000);
    const result = await request(approval, { headers: { cookie }, redirect: "manual" });
    if (result.status === 303) { callback = new URL(result.headers.get("location")); break; }
    assert.equal(result.status, 200, `Approval expired or rejected (${result.status})`);
    await result.text();
  }
  assert(callback, "Terminal approval timed out");
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get("state"), state);
  const tokenResponse = await request(new URL("/token", external), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri,
      code: callback.searchParams.get("code"), code_verifier: verifier, resource,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  accessToken = (await tokenResponse.json()).access_token;
  assert(accessToken);
  pass("public OAuth registration, terminal approval, PKCE token exchange");

  for (const base of [local, external]) {
    const client = new Client({ name: "live-mcp-smoke", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), {
      requestInit: { headers: { ...headers, authorization: `Bearer ${accessToken}` } },
    }));
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 23);
    pass(`${base.host}: MCP initialize and tools/list (23 tools)`);
    const command = await call(client, "exec_command", { cmd: "printf MCP_LIVE_OK", login: false, outputFormat: "compact" });
    assert.equal(command.structuredContent.output, "MCP_LIVE_OK");
    assert.equal(command.structuredContent.exitCode, 0);
    pass(`${base.host}: actual command execution`);
  }

  const client = clients.at(-1);
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cokac-live-smoke-"));
  const textPath = path.join(temporaryDirectory, "probe.txt");
  await call(client, "write_file", { path: textPath, content: "MCP live file check\n" });
  const read = await call(client, "read_file", { path: textPath });
  assert.equal(read.structuredContent.content, "MCP live file check\n");
  pass("public MCP file write/read in disposable directory");
  const imagePath = path.join(temporaryDirectory, "pixel.png");
  await call(client, "write_file", { path: imagePath, content: pixel.toString("base64"), encoding: "base64" });
  const viewed = await call(client, "view_image", { path: imagePath });
  const image = viewed.content.find((block) => block.type === "image");
  assert(image);
  assert.deepEqual(Buffer.from(image.data, "base64"), pixel);
  pass("public MCP original PNG image content (byte-for-byte)");

  const output = await call(client, "run_script", {
    runtime: "node", script: 'process.stdout.write("x".repeat(40000))', outputFormat: "compact",
  });
  const first = output.structuredContent;
  assert.equal(Buffer.byteLength(first.output), 32768);
  assert.equal(first.hasMore, true);
  assert.equal(first.stdout, undefined);
  const rest = await call(client, "read_process", {
    sessionId: first.sessionId, afterSeq: first.nextSeq, waitMs: 0, outputFormat: "compact",
  });
  assert.equal(first.output + rest.structuredContent.output, "x".repeat(40000));
  pass("public MCP 32 KiB compact output and lossless continuation");

  if (process.argv.includes("--capture")) {
    const targets = await call(client, "list_capture_targets", {});
    const displays = targets.structuredContent.displays;
    assert(displays.length > 0);
    const capture = await call(client, "capture_screenshot", {
      target: { kind: "region", displayId: displays[0].id, x: 0, y: 0, width: 32, height: 24 },
    });
    assert(capture.content.some((block) => block.type === "image"));
    pass(`public MCP native region capture (${capture.structuredContent.width}x${capture.structuredContent.height})`);
  }
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const client of clients) await client.close().catch(() => undefined);
  if (accessToken && clientId) {
    try {
      const revoked = await request(new URL("/revoke", external), {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken, client_id: clientId }),
      });
      assert.equal(revoked.status, 200);
      await revoked.text();
      const denied = await request(new URL("/mcp", external), { headers: { authorization: `Bearer ${accessToken}` } });
      assert.equal(denied.status, 401);
      await denied.text();
      pass("test connection revoked; its token is rejected");
    } catch (error) { console.error(`FAIL cleanup: ${error.message}`); process.exitCode = 1; }
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
