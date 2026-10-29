import { afterEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { ProcessManager, type ProcessManagerOptions } from "../src/process-manager.js";

let manager: ProcessManager;
afterEach(async () => { await manager?.shutdown(); });

function createManager(options: Partial<ProcessManagerOptions> = {}) {
  manager = new ProcessManager({
    maxRetainedOutputBytes: 1024, processRetentionMs: 60_000,
    maxProcesses: 16, defaultMaxOutputBytes: 1024, ...options,
  });
  return manager;
}

function startCompletedWork(cleanup: () => Promise<void>) {
  return manager.start({
    executable: process.execPath, args: ["-e", ""], commandForDisplay: "completed work",
    cwd: process.cwd(), cleanup,
  });
}

it("shutdown waits for cleanup even after the process has exited", async () => {
  createManager();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const session = startCompletedWork(() => gate);
  await manager.waitForExit(session, 2000);
  expect((await manager.read(session)).running).toBe(false);
  let stopped = false;
  const stopping = manager.shutdown().then(() => { stopped = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
  } finally {
    release();
    await stopping;
  }
  expect(stopped).toBe(true);
});

it("reports cleanup failure and retries only unfinished cleanup on the next shutdown", async () => {
  createManager();
  let unavailable = true;
  let recovered = false;
  let alreadyClean = false;
  const failing = startCompletedWork(async () => {
    if (unavailable) throw new Error("staging storage unavailable");
    recovered = true;
  });
  const successful = startCompletedWork(async () => {
    if (alreadyClean) throw new Error("successful cleanup repeated");
    alreadyClean = true;
  });
  await Promise.all([manager.waitForExit(failing, 2000), manager.waitForExit(successful, 2000)]);
  try {
    await expect(manager.shutdown()).rejects.toThrow("staging storage unavailable");
    expect(recovered).toBe(false);
    expect(alreadyClean).toBe(true);
  } finally {
    unavailable = false;
  }
  await manager.shutdown();
  expect(recovered).toBe(true);
});

it.each(["retention", "capacity"])("keeps cleanup responsibility after output is forgotten by %s", async (mode) => {
  createManager({ processRetentionMs: mode === "retention" ? 1 : 60_000, maxProcesses: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let cleaned = false;
  const session = startCompletedWork(async () => { await gate; cleaned = true; });
  await manager.waitForExit(session, 2000);
  if (mode === "capacity") {
    const successor = startCompletedWork(async () => {});
    await manager.waitForExit(successor, 2000);
  } else {
    await expect.poll(() => manager.list()).toEqual([]);
  }
  await expect(manager.read(session)).rejects.toThrow("Unknown process session");
  let stopped = false;
  const stopping = manager.shutdown().then(() => { stopped = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
  } finally {
    release();
    await stopping;
  }
  expect(cleaned).toBe(true);
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startStubbornTree(timeoutMs?: number, stubbornParent = false) {
  const session = manager.start({
    executable: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/stubborn-tree.mjs", import.meta.url)), ...(stubbornParent ? ["--stubborn-parent"] : [])],
    commandForDisplay: "parent with SIGTERM-resistant child", cwd: process.cwd(), timeoutMs,
  });
  let child = 0;
  await expect.poll(async () => {
    child = Number((await manager.read(session)).stdout.trim());
    return child;
  }).toBeGreaterThan(0);
  return { session, child };
}

it.skipIf(process.platform === "win32")("terminate stops a stubborn child even when its parent exits first", async () => {
  createManager();
  const { session, child } = await startStubbornTree();
  try {
    await manager.terminate(session, "SIGTERM", 100);
    await expect.poll(() => alive(child), { timeout: 1000 }).toBe(false);
  } finally {
    try { process.kill(child, "SIGKILL"); } catch {}
  }
});

it.skipIf(process.platform === "win32")("timeout also stops a stubborn child after the parent exits", async () => {
  createManager();
  const { session, child } = await startStubbornTree(2000);
  try {
    await manager.waitForExit(session, 3000);
    expect((await manager.read(session)).timedOut).toBe(true);
    await expect.poll(() => alive(child), { timeout: 6000 }).toBe(false);
  } finally {
    try { process.kill(child, "SIGKILL"); } catch {}
  }
}, 12_000);

it.skipIf(process.platform === "win32")("reports failed termination without hanging and retries after signal permission recovers", async () => {
  createManager();
  const { session } = await startStubbornTree(undefined, true);
  const parent = (await manager.read(session)).pid!;
  const kill = process.kill.bind(process);
  const denied = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -parent && (signal === "SIGTERM" || signal === "SIGKILL")) {
      throw Object.assign(new Error("EPERM: signal denied"), { code: "EPERM" });
    }
    return kill(pid, signal);
  });
  let settled = false;
  const stopping = manager.shutdown();
  const outcome = stopping.then(
    () => { settled = true; return "unexpected success"; },
    (error: Error) => { settled = true; return error.message; },
  );
  try {
    await expect.poll(() => settled, { timeout: 1200 }).toBe(true);
    expect(await outcome).toContain("EPERM");
    expect((await manager.read(session)).running).toBe(true);
    expect(() => startCompletedWork(async () => {})).toThrow("stopped");
  } finally {
    denied.mockRestore();
    if (!settled) {
      kill(-parent, "SIGKILL");
      await stopping;
    }
  }
  await manager.shutdown();
  expect((await manager.read(session)).running).toBe(false);
});

it.skipIf(process.platform === "win32")("retries descendant termination after the parent and its output record are gone", async () => {
  createManager({ processRetentionMs: 1 });
  const { session, child } = await startStubbornTree();
  const parent = (await manager.read(session)).pid!;
  const kill = process.kill.bind(process);
  const denied = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -parent && signal === "SIGKILL") {
      throw Object.assign(new Error("EPERM: child group denied"), { code: "EPERM" });
    }
    return kill(pid, signal);
  });
  try {
    try {
      await expect(manager.shutdown()).rejects.toThrow("EPERM");
    } finally {
      denied.mockRestore();
    }
    await expect.poll(() => manager.list()).toEqual([]);
    await manager.shutdown();
    await expect.poll(() => alive(child), { timeout: 1000 }).toBe(false);
  } finally {
    try { kill(child, "SIGKILL"); } catch {}
  }
});

it.skipIf(process.platform === "win32")("zero grace preserves the explicit no-escalation option", async () => {
  createManager();
  const { session, child } = await startStubbornTree();
  try {
    await manager.terminate(session, "SIGTERM", 0);
    await manager.waitForExit(session, 1000);
    expect((await manager.read(session)).running).toBe(false);
    expect(alive(child)).toBe(true);
  } finally {
    try { process.kill(child, "SIGKILL"); } catch {}
  }
});

it.skipIf(process.platform === "win32")("shutdown shortens and joins an existing long-grace termination", async () => {
  createManager();
  const { session, child } = await startStubbornTree(undefined, true);
  const initial = manager.terminate(session, "SIGTERM", 60_000);
  let stopped = false;
  const stopping = manager.shutdown().then(() => { stopped = true; });
  try {
    await expect.poll(() => stopped, { timeout: 1500 }).toBe(true);
    await initial;
    expect((await manager.read(session)).running).toBe(false);
    await expect.poll(() => alive(child)).toBe(false);
  } finally {
    await manager.terminate(session, "SIGKILL", 0);
    try { process.kill(child, "SIGKILL"); } catch {}
    await stopping;
  }
});

it.skipIf(process.platform !== "darwin")("accepts Darwin EPERM after the group has no live members", async () => {
  createManager();
  const session = manager.start({
    executable: "/bin/bash", args: ["-c", "printf ready; exec sleep 30"],
    commandForDisplay: "single process group", cwd: process.cwd(),
  });
  await expect.poll(async () => (await manager.read(session)).stdout).toBe("ready");
  const parent = (await manager.read(session)).pid!;
  const kill = process.kill.bind(process);
  const gone = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -parent && signal === "SIGKILL") {
      throw Object.assign(new Error("EPERM: zombie-only group"), { code: "EPERM" });
    }
    return kill(pid, signal);
  });
  try {
    await expect(manager.shutdown()).resolves.toBeUndefined();
  } finally {
    gone.mockRestore();
    await manager.shutdown();
  }
});
