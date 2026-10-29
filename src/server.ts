import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { startHttpServer } from "./http-server.js";
import { createServices } from "./mcp-server.js";
import { startOperatorConsole } from "./operator-console.js";
import { openSync } from "node:fs";
import { WriteStream } from "node:tty";

async function main(): Promise<void> {
  const config = loadConfig();
  const terminalApproval = config.oauthEnabled && config.oauthApprovalMode === "terminal";
  if (terminalApproval && !process.stdin.isTTY) {
    throw new Error("Terminal approval requires an interactive terminal");
  }
  // Configuration owns these secrets; executed commands must not inherit them.
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_OAUTH_APPROVAL_KEY;
  const services = createServices(config);
  const running = await startHttpServer(config, services);
  const endpointUrl = config.publicUrl
    ? `${config.publicUrl}${config.endpoint}`
    : `http://${config.host}:${config.port}${config.endpoint}`;

  console.log(`cokacremote listening at ${endpointUrl}`);
  console.log(`default cwd: ${config.defaultCwd}`);
  console.log("execution mode: unrestricted host access");
  console.log(
    config.allowNoAuth && !config.authToken && !config.oauthEnabled
      ? "authentication: disabled"
      : config.oauthEnabled
        ? config.authToken
          ? "authentication: static bearer + OAuth 2.1 (DCR/PKCE)"
          : "authentication: OAuth 2.1 (DCR/PKCE)"
        : "authentication: bearer token",
  );

  const consoleFd = terminalApproval && process.env.MCP_CONSOLE_TTY === "true" ? openSync("/dev/tty", "w") : undefined;
  const consoleOutput = consoleFd === undefined ? process.stdout : new WriteStream(consoleFd);
  const operator = terminalApproval
    ? startOperatorConsole(running.control, {
      input: process.stdin, output: consoleOutput, cwd: config.defaultCwd,
      endpoint: endpointUrl,
    })
    : undefined;
  if (terminalApproval) {
    console.log(`승인 세션: 최대 ${config.oauthSessionTtlSeconds / 3600}시간 (갱신으로 연장되지 않음)`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    operator?.close();
    if (consoleFd !== undefined) consoleOutput.destroy();
    console.log(`received ${signal}; shutting down`);
    try {
      await running.close();
      process.exitCode = 0;
    } catch (error) {
      console.error("shutdown failed:", errorMessage(error));
      process.exitCode = 1;
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("cokacremote failed to start:", errorMessage(error));
  process.exitCode = 1;
});
