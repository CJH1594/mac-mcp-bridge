import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImageReader, ImageData } from "./image-reader.js";
import type { AppConfig } from "./config.js";
import type { HostExecution } from "./host-execution.js";
import { ToolError } from "./errors.js";

export class ScreenCapture {
  constructor(private readonly config: AppConfig, private readonly execution: HostExecution, private readonly images: ImageReader) {}

  async targets(): Promise<Record<string, unknown>> { return this.invoke({ operation: "list" }); }

  async capture(target: CaptureTarget): Promise<ImageData> {
    const execution = this.execution.scope();
    const directory = await mkdtemp(path.join(os.tmpdir(), "cokac-screen-"));
    try {
      const outputPath = path.join(directory, "capture.png");
      const metadata = await this.invoke({ operation: "capture", target, outputPath, maxPixels: this.config.maxImagePixels }, execution);
      const image = await this.images.read(outputPath);
      const { path: _temporaryPath, ...details } = image.metadata;
      return { ...image, metadata: { ...metadata, ...details } };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async invoke(request: Record<string, unknown>, execution = this.execution): Promise<Record<string, unknown>> {
    if (process.platform !== "darwin" && !this.config.screenCaptureHelper) throw new ToolError("capture_unsupported", "Screen capture requires macOS 14 or later");
    const helper = this.config.screenCaptureHelper ?? fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../dist/src/native/screen-capture" : "./native/screen-capture", import.meta.url));
    let result;
    try {
      result = await execution.runFile(helper, [JSON.stringify(request)], {
        cwd: this.config.defaultCwd, maxOutputBytes: 1024 * 1024, timeoutMs: this.config.screenCaptureTimeoutMs,
      });
    } catch (error) {
      if (error instanceof ToolError && error.code === "process_timeout") throw new ToolError("capture_timeout", "Capture timed out; check screen recording permission and target availability");
      throw error;
    }
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof data.error === "string") throw new ToolError(typeof data.code === "string" ? data.code : "capture_failed", data.error);
    return data;
  }
}

export type CaptureTarget =
  | { kind: "display"; displayId: number }
  | { kind: "window"; windowId: number }
  | { kind: "region"; displayId: number; x: number; y: number; width: number; height: number };
