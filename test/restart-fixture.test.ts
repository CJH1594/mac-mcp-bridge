import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";

import { startHttpFixture } from "./helpers/http-fixture.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function startObservedServer(port: number) {
  const httpServer = createServer((request, response) => {
    if (request.url === "/stream") {
      response.write("unfinished");
      return;
    }
    response.end(JSON.stringify({ socket: request.socket.remotePort, connection: request.headers.connection }));
  });
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  return {
    httpServer,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
  };
}

it("reuses a live connection within a server generation", async () => {
  const app = await startHttpFixture(startObservedServer);
  disposals.push(() => app.close());
  const { fetch, baseUrl } = app.current;
  const first = await (await fetch(baseUrl)).json();
  const second = await (await fetch(baseUrl)).json();
  expect(second).toEqual(first);
  expect(first.connection).toBe("keep-alive");
});

it("cancels an unread response so restart does not wait for its server stream", async () => {
  const app = await startHttpFixture(startObservedServer);
  disposals.push(() => app.close());
  const response = await app.current.fetch(`${app.current.baseUrl}/stream`);
  let restarted = false;
  const restarting = app.restart().then(() => { restarted = true; });
  try {
    await expect.poll(() => restarted, { timeout: 250 }).toBe(true);
  } finally {
    await response.body?.cancel();
    await restarting;
  }
});

it("bounds cleanup of a locked response and a queued request before restart", async () => {
  const app = await startHttpFixture(startObservedServer, { closeTimeoutMs: 50 });
  disposals.push(() => app.close());
  const old = app.current;
  const response = await old.fetch(`${old.baseUrl}/stream`);
  const reader = response.body!.getReader();
  await reader.read();
  const reading = reader.read().then(() => "completed", () => "aborted");
  const queued = old.fetch(old.baseUrl).then(() => "completed", () => "aborted");
  let restarted = false;
  const restarting = app.restart().then(() => { restarted = true; });
  try {
    await expect.poll(() => restarted, { timeout: 500 }).toBe(true);
    expect(await reading).toBe("aborted");
    expect(await queued).toBe("aborted");
  } finally {
    await reader.cancel().catch(() => {});
    await restarting;
  }
});

it("retires old clients before accepting a POST on the same port after restart", async () => {
  const app = await startHttpFixture(startObservedServer);
  disposals.push(() => app.close());
  const old = app.current;
  const first = await (await old.fetch(old.baseUrl)).json();
  await app.restart();
  expect(app.current.baseUrl).toBe(old.baseUrl);
  await expect(old.fetch(old.baseUrl, { method: "POST" })).rejects.toThrow("retired");
  const second = await (await app.current.fetch(app.current.baseUrl, { method: "POST" })).json();
  expect(second.socket).not.toBe(first.socket);
  expect(second.connection).toBe("keep-alive");
});

it("does not leave a new server running when close overlaps restart", async () => {
  let release!: () => void;
  let entered!: () => void;
  const starting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  const app = await startHttpFixture(async (port) => {
    if (++starts === 2) { entered(); await gate; }
    return startObservedServer(port);
  });
  disposals.push(() => app.close());
  const restarting = app.restart();
  await starting;
  const closing = app.close();
  release();
  await Promise.all([restarting, closing]);
  expect(app.current.running.httpServer.listening).toBe(false);
  await expect(app.current.fetch(app.current.baseUrl)).rejects.toThrow("retired");
});
