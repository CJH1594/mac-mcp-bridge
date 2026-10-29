import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

// Filesystem exhaustion is an OS fault; the application modules remain real.
vi.mock("node:fs/promises", async (original) => {
  const filesystem = await original<typeof import("node:fs/promises")>();
  return { ...filesystem, writeFile: vi.fn(filesystem.writeFile) };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  } finally {
    vi.mocked(writeFile).mockReset();
    vi.unstubAllEnvs();
  }
});

async function startApp() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cokac-execution-lifecycle-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({
    MCP_HOST: "127.0.0.1", MCP_AUTH_TOKEN: "execution-lifecycle-test",
    MCP_DEFAULT_CWD: directory,
  });
  config.port = 0;
  const running = await startHttpServer(config, createServices(config));
  cleanup.push(() => running.close());
  const client = new Client({ name: "execution-lifecycle-test", version: "1" });
  cleanup.push(() => client.close());
  const baseUrl = `http://127.0.0.1:${(running.httpServer.address() as AddressInfo).port}`;
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: "Bearer execution-lifecycle-test" } },
  }));
  return { directory, running, client };
}

describe("managed host execution", () => {
  it("never starts a disconnected request's script after new work is allowed", async () => {
    const app = await startApp();
    const filesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let release!: () => void;
    let entered!: () => void;
    let staging = "";
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      staging = path.dirname(String(args[0]));
      entered();
      await gate;
      return filesystem.writeFile(...args);
    });
    const marker = path.join(app.directory, "stale-work");
    const pending = app.client.callTool({
      name: "run_script", arguments: {
        runtime: "node", script: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'stale');`,
      },
    }).catch(() => undefined);
    try {
      await preparing;
      await app.running.control.disconnect();
    } finally { release(); }
    await pending;
    await expect.poll(async () => { try { await stat(staging); return true; } catch { return false; } }).toBe(false);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes script staging files when the filesystem cannot write the script", async () => {
    const app = await startApp();
    const staging = path.join(app.directory, "staging");
    await mkdir(staging);
    vi.stubEnv("TMPDIR", staging);
    vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error("ENOSPC: disk full"), { code: "ENOSPC" }));
    const result = await app.client.callTool({
      name: "run_script", arguments: { runtime: "node", script: "console.log('ok')" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: expect.stringContaining("ENOSPC") });
    const listing = await app.client.callTool({ name: "list_directory", arguments: { path: staging } });
    expect(listing.structuredContent).toMatchObject({ entries: [] });
  });

  it("removes patch staging files when the filesystem cannot write the patch", async () => {
    const app = await startApp();
    const staging = path.join(app.directory, "staging");
    await mkdir(staging);
    vi.stubEnv("TMPDIR", staging);
    vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error("ENOSPC: disk full"), { code: "ENOSPC" }));
    const result = await app.client.callTool({
      name: "apply_patch", arguments: { patch: "test patch", cwd: app.directory },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: expect.stringContaining("ENOSPC") });
    const listing = await app.client.callTool({ name: "list_directory", arguments: { path: staging } });
    expect(listing.structuredContent).toMatchObject({ entries: [] });
  });
  it("includes an in-flight git patch in managed work and stops its process", async () => {
    const app = await startApp();
    const bin = path.join(app.directory, "bin");
    const marker = path.join(app.directory, "git-ready");
    await mkdir(bin);
    const fixture = fileURLToPath(new URL("./fixtures/waiting-git.mjs", import.meta.url));
    await copyFile(fixture, path.join(bin, "git"));
    await chmod(path.join(bin, "git"), 0o700);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv("TEST_GIT_READY", marker);
    const pending = app.client.callTool({
      name: "apply_patch", arguments: { patch: "test patch", cwd: app.directory },
    }).then((result) => result, () => undefined);
    await expect.poll(async () => {
      try { return Number(await readFile(marker, "utf8")); } catch { return 0; }
    }).toBeGreaterThan(0);
    const pid = Number(await readFile(marker, "utf8"));
    cleanup.push(async () => { try { process.kill(pid, "SIGKILL"); } catch {} });

    const inventory = await app.client.callTool({ name: "list_processes", arguments: {} });
    expect(inventory.structuredContent).toMatchObject({
      processes: expect.arrayContaining([expect.objectContaining({ pid, running: true })]),
    });
    await app.running.control.stopAccess();
    await expect.poll(() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }).toBe(false);
    await pending;
  });
});
