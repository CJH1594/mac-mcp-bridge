import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage, ToolError } from "./errors.js";
import type { ImageData } from "./image-reader.js";

export async function runImageTool(operation: () => Promise<ImageData>): Promise<CallToolResult> {
  try {
    const image = await operation();
    return { content: [
      { type: "image", data: image.data, mimeType: image.mimeType },
      { type: "text", text: JSON.stringify(image.metadata) },
    ], structuredContent: image.metadata };
  } catch (error) { return errorResult(error); }
}

export function successResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function errorResult(error: unknown): CallToolResult {
  const data = { error: errorMessage(error), ...(error instanceof ToolError ? { code: error.code } : {}) };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: true,
  };
}

export async function runTool(
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return successResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}
