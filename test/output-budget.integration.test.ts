import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";
import { startHttpFixture } from "./helpers/http-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function startApp(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cokac-output-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({ MCP_AUTH_TOKEN: "output-test", MCP_HOST: "127.0.0.1", MCP_DEFAULT_CWD: directory, ...env });
  const app = await startHttpFixture((port) => { config.port = port; return startHttpServer(config, createServices(config)); });
  cleanup.push(() => app.close());
  return { directory, client: await app.current.connectMcp({ authorization: "Bearer output-test" }) };
}

it("returns 32 KiB by default and allows a larger explicit process page", async () => {
  const { client } = await startApp();
  const first = (await client.callTool({ name: "exec_command", arguments: {
    cmd: `node -e "process.stdout.write('x'.repeat(100000))"`, login: false, yieldTimeMs: 3000,
  } })).structuredContent as Record<string, unknown>;
  expect(Buffer.byteLength(String(first.stdout))).toBeLessThanOrEqual(32768);
  expect(first.hasMore).toBe(true);
  const next = (await client.callTool({ name: "read_process", arguments: {
    sessionId: first.sessionId, afterSeq: first.nextSeq, maxOutputBytes: 131072,
  } })).structuredContent as Record<string, unknown>;
  expect(String(first.stdout) + String(next.stdout)).toBe("x".repeat(100000));
});

it("reads text files in small UTF-8 pages and resumes without losing characters", async () => {
  const { client, directory } = await startApp();
  const text = "한글".repeat(10000);
  await writeFile(path.join(directory, "large.txt"), text);
  const first = (await client.callTool({ name: "read_file", arguments: { path: "large.txt" } })).structuredContent as Record<string, unknown>;
  expect(Number(first.bytesRead)).toBeLessThanOrEqual(32771);
  expect(first.eof).toBe(false);
  const next = (await client.callTool({ name: "read_file", arguments: { path: "large.txt", offset: first.nextOffset, maxBytes: 65536 } })).structuredContent as Record<string, unknown>;
  expect(String(first.content) + String(next.content)).toBe(text);
  expect(next.eof).toBe(true);
});

it("offers compact process output while preserving the legacy fields by default", async () => {
  const { client } = await startApp();
  const compact = (await client.callTool({ name: "exec_command", arguments: {
    cmd: "printf hello; printf warning >&2", login: false, yieldTimeMs: 2000, outputFormat: "compact",
  } })).structuredContent as Record<string, unknown>;
  expect(String(compact.output)).toContain("hello");
  expect(String(compact.output)).toContain("warning");
  expect(compact).not.toHaveProperty("stdout");
  expect(compact).not.toHaveProperty("stderr");
  const legacy = (await client.callTool({ name: "read_process", arguments: { sessionId: compact.sessionId, waitMs: 0 } })).structuredContent as Record<string, unknown>;
  expect(legacy).toMatchObject({ stdout: "hello", stderr: "warning" });
});

it.each(["tail", "failure"])("shows the %s excerpt without advancing the sequential cursor", async (view) => {
  const { client } = await startApp();
  const first = (await client.callTool({ name: "run_script", arguments: {
    runtime: "node", yieldTimeMs: 3000,
    script: `process.stdout.write("x".repeat(100000)); process.stderr.write("fatal: build failed\\n"); process.stdout.write("final context\\n"); process.exitCode = 7;`,
  } })).structuredContent as Record<string, unknown>;
  const preview = (await client.callTool({ name: "read_process", arguments: {
    sessionId: first.sessionId, afterSeq: first.nextSeq, view, waitMs: 0,
  } })).structuredContent as Record<string, unknown>;
  expect(String(preview.output).includes("final context")).toBe(true);
  if (view === "failure") expect(preview.stderr).toContain("fatal: build failed");
  expect(preview.nextSeq).toBe(first.nextSeq);
  expect(preview.view).toBe(view);
  expect(preview.omittedBefore || preview.omittedBetween || preview.omittedAfter).toBe(true);
  const rest = (await client.callTool({ name: "read_process", arguments: {
    sessionId: first.sessionId, afterSeq: first.nextSeq, maxOutputBytes: 131072, waitMs: 0,
  } })).structuredContent as Record<string, unknown>;
  expect(String(first.stdout) + String(rest.stdout)).toBe("x".repeat(100000) + "final context\n");
  expect(String(first.stderr) + String(rest.stderr)).toBe("fatal: build failed\n");
});

it("reports a cursor gap when retained process output has already been discarded", async () => {
  const { client } = await startApp({ MCP_MAX_RETAINED_PROCESS_OUTPUT_BYTES: "65536" });
  const started = (await client.callTool({ name: "run_script", arguments: {
    runtime: "node", script: `process.stdout.write("x".repeat(200000));`, yieldTimeMs: 3000,
  } })).structuredContent as Record<string, unknown>;
  const page = (await client.callTool({ name: "read_process", arguments: { sessionId: started.sessionId, afterSeq: 0, waitMs: 0 } })).structuredContent as Record<string, unknown>;
  expect(page.cursorGap).toBe(true);
  expect(Number(page.firstAvailableSeq)).toBeGreaterThan(1);
  expect(Number(page.droppedOutputBytes)).toBeGreaterThan(0);
});
