import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolError } from "./errors.js";

import type { ProcessManager, ProcessReadResult, StartProcessRequest } from "./process-manager.js";

interface InitialRead {
  yieldTimeMs?: number;
  maxOutputBytes?: number;
}

export interface CommandRequest extends InitialRead {
  cmd: string;
  cwd: string;
  shell: string;
  login?: boolean;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export type ScriptRuntime = "bash" | "sh" | "node" | "python" | "custom";

export interface RunScriptRequest {
  runtime: ScriptRuntime;
  script: string;
  cwd: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  interpreter?: string | undefined;
  interpreterArgs?: string[] | undefined;
  timeoutMs?: number | undefined;
  yieldTimeMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  stdin?: string | undefined;
  keepScript?: boolean | undefined;
}

export interface RunScriptResult extends ProcessReadResult {
  scriptPath: string | undefined;
}

interface RuntimeDefinition {
  executable: string;
  extension: string;
}

function runtimeDefinition(request: RunScriptRequest): RuntimeDefinition {
  if (request.runtime === "custom") {
    if (!request.interpreter?.trim()) {
      throw new Error("interpreter is required when runtime is custom");
    }
    return {
      executable: request.interpreter,
      extension: ".script",
    };
  }

  const definitions: Record<Exclude<ScriptRuntime, "custom">, RuntimeDefinition> = {
    bash: { executable: request.interpreter || "bash", extension: ".sh" },
    sh: { executable: request.interpreter || "sh", extension: ".sh" },
    node: { executable: request.interpreter || process.execPath, extension: ".mjs" },
    python: { executable: request.interpreter || "python3", extension: ".py" },
  };
  return definitions[request.runtime];
}

function displayCommand(executable: string, args: string[]): string {
  return [executable, ...args].map((value) => JSON.stringify(value)).join(" ");
}

/** Owns host execution through the same process lifetime used by MCP jobs. */
export class HostExecution {
  constructor(private readonly processes: ProcessManager,
    private readonly scopedStart?: (request: StartProcessRequest) => string) {}

  scope(): HostExecution {
    return new HostExecution(this.processes, this.scopedStart ?? this.processes.captureStart());
  }

  async command(request: CommandRequest): Promise<ProcessReadResult> {
    const sessionId = (this.scopedStart ?? this.processes.captureStart())({
      executable: request.shell,
      args: [request.login === false ? "-c" : "-lc", request.cmd],
      commandForDisplay: request.cmd,
      cwd: request.cwd,
      env: request.env,
      stdin: request.stdin,
      timeoutMs: request.timeoutMs,
    });
    return this.readInitial(sessionId, request);
  }

  async script(request: RunScriptRequest): Promise<RunScriptResult> {
    const start = this.scopedStart ?? this.processes.captureStart();
    const runtime = runtimeDefinition(request);
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "remote-dev-mcp-script-"),
    );
    const scriptPath = path.join(temporaryDirectory, `script${runtime.extension}`);

    const processArgs = [
      ...(request.interpreterArgs ?? []),
      scriptPath,
      ...(request.args ?? []),
    ];
    const keepScript = request.keepScript ?? false;
    const cleanup = keepScript
      ? undefined
      : async () => {
          await rm(temporaryDirectory, { recursive: true, force: true });
        };

    let sessionId: string;
    try {
      await writeFile(scriptPath, request.script, { mode: 0o700 });
      await chmod(scriptPath, 0o700);
      sessionId = start({
        executable: runtime.executable,
        args: processArgs,
        commandForDisplay: displayCommand(runtime.executable, processArgs),
        cwd: request.cwd,
        env: request.env,
        timeoutMs: request.timeoutMs,
        stdin: request.stdin,
        cleanup,
      });
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }

    const result = await this.readInitial(sessionId, request);
    return {
      ...result,
      scriptPath: keepScript ? scriptPath : undefined,
    };
  }

  async runFile(
    executable: string,
    args: string[],
    options: { cwd: string; maxOutputBytes: number; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    const sessionId = (this.scopedStart ?? this.processes.captureStart())({
      executable,
      args,
      cwd: options.cwd,
      commandForDisplay: displayCommand(executable, args),
      closeStdin: true,
      timeoutMs: options.timeoutMs,
    });
    let result;
    do {
      result = await this.readInitial(sessionId, { yieldTimeMs: 30_000, maxOutputBytes: options.maxOutputBytes });
    } while (result.running);
    if (result.timedOut) throw new ToolError("process_timeout", result.error ?? "Process timed out");
    if (result.exitCode !== 0 || result.signal || result.error) {
      throw new Error([
        `Command failed: ${result.command}`,
        result.error || result.signal,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"));
    }
    if (result.hasMore || result.droppedOutputBytes > 0) {
      throw new Error(`Command output exceeded ${options.maxOutputBytes} bytes`);
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  private async readInitial(sessionId: string, options: InitialRead): Promise<ProcessReadResult> {
    await this.processes.waitForExit(sessionId, options.yieldTimeMs ?? 10_000);
    return this.processes.read(sessionId, { maxOutputBytes: options.maxOutputBytes });
  }
}
