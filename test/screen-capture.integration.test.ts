import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpFixture } from "./helpers/http-fixture.js";
import { pixel } from "./fixtures/pixel.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const dispose of cleanup.splice(0).reverse()) await dispose(); }
  finally { vi.unstubAllEnvs(); }
});
async function startApp(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cokac-capture-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const helper = path.join(directory, "helper");
  await copyFile(fileURLToPath(new URL("./fixtures/capture-helper.mjs", import.meta.url)), helper);
  await chmod(helper, 0o700);
  await writeFile(path.join(directory, "pixel.png"), pixel);
  vi.stubEnv("CAPTURE_FIXTURE_PNG", path.join(directory, "pixel.png"));
  vi.stubEnv("CAPTURE_FIXTURE_RECORD", path.join(directory, "request.json"));
  vi.stubEnv("TMPDIR", directory);
  const config = loadConfig({ MCP_AUTH_TOKEN: "capture-test", MCP_HOST: "127.0.0.1", MCP_DEFAULT_CWD: directory, MCP_SCREEN_CAPTURE_HELPER: helper, ...env });
  const app = await startHttpFixture((port) => { config.port = port; return startHttpServer(config, createServices(config)); });
  cleanup.push(() => app.close());
  return { directory, app, client: await app.current.connectMcp({ authorization: "Bearer capture-test" }) };
}

it("lists capture targets through the managed native helper", async () => {
  const { client } = await startApp();
  const result = await client.callTool({ name: "list_capture_targets", arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ displays: [{ id: 7, scale: 2 }], windows: [{ id: 11 }] });
});

it.each([
  { kind: "display", displayId: 7 },
  { kind: "window", windowId: 11 },
  { kind: "region", displayId: 7, x: 4, y: 5, width: 10, height: 12 },
])("captures $kind as an original image and removes staging files", async (target) => {
  const { client, directory } = await startApp();
  const result = await client.callTool({ name: "capture_screenshot", arguments: { target } });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  const images = result.content as Array<{ type: string; data?: string }>;
  expect(Buffer.from(images.find((item) => item.type === "image")!.data!, "base64")).toEqual(pixel);
  const record = JSON.parse(await readFile(path.join(directory, "request.json"), "utf8"));
  expect(record.target).toEqual(target);
  expect((await readdir(directory)).filter((name) => name.startsWith("cokac-screen-"))).toEqual([]);
});

it("times out a stuck capture and removes its staging directory", async () => {
  const { client, directory, app } = await startApp({ MCP_SCREEN_CAPTURE_TIMEOUT_MS: "100" });
  vi.stubEnv("CAPTURE_FIXTURE_MODE", "hang");
  let result: Awaited<ReturnType<typeof client.callTool>> | undefined;
  let settled = false;
  const pending = client.callTool({ name: "capture_screenshot", arguments: { target: { kind: "display", displayId: 7 } } })
    .then((value) => { result = value; settled = true; }, () => { settled = true; });
  try {
    await expect.poll(() => settled, { timeout: 1200 }).toBe(true);
    expect(result?.structuredContent).toMatchObject({ code: "capture_timeout" });
    expect((await readdir(directory)).filter((name) => name.startsWith("cokac-screen-"))).toEqual([]);
  } finally {
    if (!settled) await app.current.running.control.stopAccess();
    await pending;
  }
});

it("reports permission failure and removes staging files", async () => {
  const { client, directory } = await startApp();
  vi.stubEnv("CAPTURE_FIXTURE_MODE", "denied");
  const result = await client.callTool({ name: "capture_screenshot", arguments: { target: { kind: "window", windowId: 11 } } });
  expect(result.structuredContent).toMatchObject({ code: "capture_permission_denied" });
  expect(result.isError).toBe(true);
  expect((await readdir(directory)).filter((name) => name.startsWith("cokac-screen-"))).toEqual([]);
});

it("emergency stop ends an in-flight capture and removes its temporary image directory", async () => {
  const { client, app, directory } = await startApp();
  vi.stubEnv("CAPTURE_FIXTURE_MODE", "hang");
  const pending = client.callTool({ name: "capture_screenshot", arguments: { target: { kind: "display", displayId: 7 } } }).catch(() => undefined);
  let pid = 0;
  await expect.poll(async () => {
    try { pid = JSON.parse(await readFile(path.join(directory, "request.json"), "utf8")).pid; } catch {}
    return pid;
  }).toBeGreaterThan(0);
  await app.current.running.control.stopAccess();
  await pending;
  await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
  await expect.poll(async () => (await readdir(directory)).filter((name) => name.startsWith("cokac-screen-"))).toEqual([]);
});
