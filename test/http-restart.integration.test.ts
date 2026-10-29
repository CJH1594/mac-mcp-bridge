import type { Socket } from "node:net";
import { expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpFixture } from "./helpers/http-fixture.js";

it("accepts a fresh POST after normal restart on the same port", async () => {
  const config = loadConfig({ MCP_HOST: "127.0.0.1", MCP_AUTH_TOKEN: "restart-fixture" });
  let generation = 0;
  const sockets = new Map<Socket, number>();
  const requests: Array<{ socket: Socket; generation: number }> = [];
  const app = await startHttpFixture(async (port) => {
    config.port = port;
    const running = await startHttpServer(config, createServices(config));
    const currentGeneration = ++generation;
    running.httpServer.on("connection", (socket) => { sockets.set(socket, currentGeneration); });
    running.httpServer.on("request", (request) => {
      requests.push({ socket: request.socket, generation: Number(request.headers["x-test-generation"]) });
    });
    return running;
  });
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const old = app.current;
      const oldGeneration = generation;
      for (let warmup = 0; warmup < 2; warmup++) {
        await (await old.fetch(`${old.baseUrl}/health`, {
          headers: { "x-test-generation": String(oldGeneration) },
        })).arrayBuffer();
      }
      const [first, second] = requests.slice(-2);
      expect(second!.socket).toBe(first!.socket);
      const sdkStart = requests.length;
      const client = await old.connectMcp({
        authorization: "Bearer restart-fixture", "x-test-generation": String(oldGeneration),
      });
      await client.listTools();
      const sdkRequests = requests.slice(sdkStart);
      expect(sdkRequests.length).toBeGreaterThan(0);
      expect(sdkRequests.every(({ socket }) => socket === first!.socket)).toBe(true);
      await app.restart();
      await expect(old.fetch(`${old.baseUrl}/mcp`, {
        method: "POST", headers: { "x-test-generation": String(oldGeneration) },
      })).rejects.toThrow("retired");
      const response = await app.current.fetch(`${app.current.baseUrl}/mcp`, {
        method: "POST", body: "{}",
        headers: { "content-type": "application/json", "x-test-generation": String(generation) },
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  } finally {
    await app.close();
  }
  expect(requests.every(({ socket, generation }) => sockets.get(socket) === generation)).toBe(true);
});
