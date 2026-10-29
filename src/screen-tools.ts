import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import type { ScreenCapture } from "./screen-capture.js";
import { runTool, runImageTool } from "./tool-result.js";
import * as z from "zod/v4";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";

export function registerScreenTools(server: McpServer, config: AppConfig, capture: ScreenCapture): void {
  server.registerTool("list_capture_targets", {
    title: "List capture targets", description: "List available displays and windows with IDs, bounds in logical points, and pixel scale. Requires screen recording permission on macOS.",
    inputSchema: {}, annotations: TOOL_ANNOTATIONS.readOnlyClosed, _meta: toolAuthMetadata(config),
  }, () => runTool(() => capture.targets()));
  const id = () => z.number().int().positive();
  server.registerTool("capture_screenshot", {
    title: "Capture screenshot", description: "Capture one display, window, or display-local region and return an original PNG image. Region coordinates use logical points from the display's top-left; returned dimensions use pixels. Requires screen recording permission.",
    inputSchema: { target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("display"), displayId: id() }),
      z.object({ kind: z.literal("window"), windowId: id() }),
      z.object({ kind: z.literal("region"), displayId: id(), x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive(), height: z.number().positive() }),
    ]).describe("A display or window ID from list_capture_targets, or a rectangle in display-local logical points.") },
    annotations: TOOL_ANNOTATIONS.readOnlyClosed, _meta: toolAuthMetadata(config),
  }, ({ target }) => runImageTool(() => capture.capture(target)));
}
