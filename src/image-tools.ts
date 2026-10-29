import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AppConfig } from "./config.js";
import type { ImageReader } from "./image-reader.js";
import { runImageTool } from "./tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";

export function registerImageTools(server: McpServer, config: AppConfig, images: ImageReader): void {
  server.registerTool("view_image", {
    title: "View image", description: "Return an original PNG as image content, with dimensions and byte size. No resizing or recompression is performed.",
    inputSchema: { path: z.string().min(1).describe("PNG file path."), cwd: z.string().optional().describe("Working directory for relative paths.") },
    annotations: TOOL_ANNOTATIONS.readOnlyClosed, _meta: toolAuthMetadata(config),
  }, ({ path, cwd }) => runImageTool(() => images.read(path, cwd)));
}
