import { open } from "node:fs/promises";
import { PNG } from "pngjs";
import type { FileService } from "./file-service.js";
import { ToolError } from "./errors.js";

export interface ImageData {
  data: string;
  mimeType: "image/png";
  metadata: Record<string, unknown>;
}

export class ImageReader {
  constructor(private readonly files: FileService, private readonly maxBytes: number, private readonly maxPixels: number) {}

  async read(inputPath: string, cwd?: string): Promise<ImageData> {
    const resolved = this.files.resolve(inputPath, cwd);
    const handle = await open(resolved, "r");
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new ToolError("invalid_image", "Image path must be a regular file");
      if (info.size > this.maxBytes) throw new ToolError("image_too_large", `Image exceeds ${this.maxBytes} bytes; choose a smaller capture region`);
      const buffer = Buffer.alloc(Math.min(info.size + 1, this.maxBytes + 1));
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > info.size) throw new ToolError("image_changed", "Image grew while being read; retry with a stable file");
      bytes = buffer.subarray(0, length);
    } finally { await handle.close(); }
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || bytes.toString("ascii", 12, 16) !== "IHDR") {
      throw new ToolError("invalid_png", "Expected a complete PNG image");
    }
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > this.maxPixels) throw new ToolError("image_dimensions_exceeded", `Image exceeds ${this.maxPixels} pixels; choose a smaller capture region`);
    try { PNG.sync.read(bytes); } catch { throw new ToolError("invalid_png", "PNG data is corrupt or incomplete"); }
    return { data: bytes.toString("base64"), mimeType: "image/png", metadata: { path: resolved, width, height, bytes: bytes.length, mimeType: "image/png" } };
  }
}
