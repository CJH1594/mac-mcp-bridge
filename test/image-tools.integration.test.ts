import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpFixture } from "./helpers/http-fixture.js";
import { pixel } from "./fixtures/pixel.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function startApp(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cokac-image-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({ MCP_AUTH_TOKEN: "image-test", MCP_HOST: "127.0.0.1", MCP_DEFAULT_CWD: directory, ...env });
  const app = await startHttpFixture((port) => { config.port = port; return startHttpServer(config, createServices(config)); });
  cleanup.push(() => app.close());
  return { directory, app, client: await app.current.connectMcp({ authorization: "Bearer image-test" }) };
}

it("returns original PNG bytes as image content without repeating them as text", async () => {
  const { client, directory } = await startApp();
  await writeFile(path.join(directory, "pixel.png"), pixel);
  const result = await client.callTool({ name: "view_image", arguments: { path: "pixel.png" } });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  const image = (result.content as Array<{ type: string; data?: string; mimeType?: string }>).find((item) => item.type === "image")!;
  expect(image.mimeType).toBe("image/png");
  expect(Buffer.from(image.data!, "base64")).toEqual(pixel);
  expect(result.structuredContent).toMatchObject({ width: 1, height: 1, bytes: pixel.length });
  expect(JSON.stringify(result.structuredContent)).not.toContain(pixel.toString("base64"));
  expect(JSON.stringify((result.content as Array<{ type: string }>).filter((item) => item.type === "text"))).not.toContain(pixel.toString("base64"));
});

it("rejects images above their own byte budget before returning image data", async () => {
  const { client, directory } = await startApp({ MCP_MAX_IMAGE_BYTES: "64" });
  await writeFile(path.join(directory, "pixel.png"), pixel);
  const result = await client.callTool({ name: "view_image", arguments: { path: "pixel.png" } });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ code: "image_too_large" });
});

it.each(["corrupt", "pixels"])("rejects %s PNG input with an actionable error", async (kind) => {
  const { client, directory } = await startApp({ MCP_MAX_IMAGE_PIXELS: "1" });
  const bytes = Buffer.from(pixel);
  if (kind === "pixels") bytes.writeUInt32BE(100_000, 16);
  else bytes[45] = bytes[45]! ^ 255;
  await writeFile(path.join(directory, "bad.png"), bytes);
  const result = await client.callTool({ name: "view_image", arguments: { path: "bad.png" } });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ code: kind === "pixels" ? "image_dimensions_exceeded" : "invalid_png" });
});
