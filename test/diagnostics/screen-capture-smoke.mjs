import { loadConfig } from "../../src/config.ts";
import { startHttpServer } from "../../src/http-server.ts";
import { createServices } from "../../src/mcp-server.ts";
import { startHttpFixture } from "../helpers/http-fixture.ts";

const config = loadConfig({ MCP_AUTH_TOKEN: "capture-smoke", MCP_HOST: "127.0.0.1" });
const app = await startHttpFixture((port) => { config.port = port; return startHttpServer(config, createServices(config)); });
try {
  const client = await app.current.connectMcp({ authorization: "Bearer capture-smoke" });
  const listed = await client.callTool({ name: "list_capture_targets", arguments: {} });
  if (listed.isError) {
    console.log(JSON.stringify(listed.structuredContent));
    process.exitCode = 2;
  } else {
    const { displays, windows } = listed.structuredContent;
    console.log(JSON.stringify({ displays: displays.length, windows: windows.length }));
    if (process.argv.includes("--capture") && displays.length) {
      const targets = [
        { kind: "display", displayId: displays[0].id },
        { kind: "region", displayId: displays[0].id, x: 0, y: 0, width: 32, height: 24 },
        ...(windows.length ? [{ kind: "window", windowId: windows[0].id }] : []),
      ];
      for (const target of targets) {
        const result = await client.callTool({ name: "capture_screenshot", arguments: { target } });
        const { width, height, bytes, code, error } = result.structuredContent;
        console.log(JSON.stringify({ kind: target.kind, width, height, bytes, code, error }));
        if (result.isError) process.exitCode = 1;
      }
    }
  }
} finally { await app.close(); }
