import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppConfig } from "./config.js";
import { registerExecTools } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { registerFileTools } from "./file-tools.js";
import { ProcessManager } from "./process-manager.js";
import { HostExecution } from "./host-execution.js";
import { ImageReader } from "./image-reader.js";
import { registerImageTools } from "./image-tools.js";
import { ScreenCapture } from "./screen-capture.js";
import { registerScreenTools } from "./screen-tools.js";

export interface McpServices {
  processManager: ProcessManager;
  fileService: FileService;
  execution: HostExecution;
  images: ImageReader;
  capture: ScreenCapture;
}

export function createServices(config: AppConfig): McpServices {
  const processManager = new ProcessManager({
    maxRetainedOutputBytes: config.maxRetainedProcessOutputBytes,
    processRetentionMs: config.processRetentionMs,
    maxProcesses: config.maxProcesses,
    defaultMaxOutputBytes: config.defaultOutputBytes,
    maxOutputBytes: config.maxOutputBytes,
  });
  const execution = new HostExecution(processManager);
  const fileService = new FileService({
    defaultCwd: config.defaultCwd, maxChunkBytes: config.maxFileChunkBytes,
    maxEditFileBytes: config.maxEditFileBytes, maxOutputBytes: config.maxOutputBytes,
  }, execution);
  const images = new ImageReader(fileService, config.maxImageBytes, config.maxImagePixels);
  return {
    processManager,
    execution,
    fileService,
    images,
    capture: new ScreenCapture(config, execution, images),
  };
}

export function createMcpServer(config: AppConfig, services: McpServices): McpServer {
  const server = new McpServer(
    {
      name: "cokacremote",
      version: "0.1.0",
    },
    {
      instructions:
        "This server is an unrestricted remote development environment. Tools operate directly on the host with the MCP service process's full OS permissions. Use exec_command for shell, build, test, package, Git, service, and log workflows; run_script for complete Bash, Node.js, or Python scripts; and the file tools for direct file operations. Use view_image for original PNG images. On macOS, list_capture_targets and capture_screenshot return desktop images directly. Process and text file reads default to 32 KiB; continue using nextSeq or nextOffset. Use outputFormat=compact to avoid duplicate process output, and read_process view=failure for recent stderr and ending context. Tail/failure excerpts preserve the supplied cursor. Poll long-running commands with read_process or write_stdin.",
      capabilities: { logging: {} },
    },
  );

  registerExecTools(server, config, services);
  registerFileTools(server, config, services.fileService);
  registerImageTools(server, config, services.images);
  registerScreenTools(server, config, services.capture);
  return server;
}
