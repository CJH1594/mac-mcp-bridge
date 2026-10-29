import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface RunningServer {
  httpServer: Server;
  close(): Promise<void>;
}

/** The fixture owns both sides of a local HTTP server generation. */
export async function startHttpFixture<T extends RunningServer>(
  start: (port: number) => Promise<T>,
  options: { port?: number; closeTimeoutMs?: number } = {},
) {
  async function generation(port: number) {
    const running = await start(port);
    const agent = new Agent({ connections: 1 });
    const baseUrl = `http://127.0.0.1:${(running.httpServer.address() as AddressInfo).port}`;
    let retired = false;
    let closing: Promise<void> | undefined;
    const responses = new Set<Response>();
    const controller = new AbortController();
    const clients: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];
    const dispatch: typeof fetch = async (input, init) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const requestInit = { ...init, dispatcher: agent, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal };
      try {
        const response = await fetch(input, requestInit);
        responses.add(response);
        return response;
      } catch (cause) {
        const url = new URL(input instanceof Request ? input.url : String(input));
        throw new Error(`HTTP ${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname} failed`, { cause });
      }
    };
    const generationFetch: typeof fetch = (input, init) => {
      if (retired) return Promise.reject(new Error("HTTP server generation is retired"));
      return dispatch(input, init);
    };
    return {
      running, baseUrl, fetch: generationFetch,
      async connectMcp(headers?: HeadersInit) {
        if (retired) throw new Error("HTTP server generation is retired");
        const client = new Client({ name: "http-fixture", version: "1" });
        const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          fetch: dispatch, requestInit: { headers },
        });
        clients.push({ client, transport });
        await client.connect(transport);
        return client;
      },
      close() {
        retired = true;
        return closing ??= (async () => {
          const errors: unknown[] = [];
          let forced = false;
          let destroying: Promise<void> | undefined;
          const timeout = setTimeout(() => {
            forced = true;
            controller.abort();
            destroying = agent.destroy().catch((error) => { errors.push(error); });
          }, options.closeTimeoutMs ?? 1000);
          try {
            // Session termination may need HTTP, so keep this generation's pool alive until clients close.
            await Promise.all(clients.map(async ({ client, transport }) => {
              try { await transport.terminateSession(); } catch (error) { if (!forced) errors.push(error); }
              try { await client.close(); } catch (error) { if (!forced) errors.push(error); }
            }));
            const canceled = await Promise.allSettled([...responses].map((response) => response.body?.locked ? undefined : response.body?.cancel()));
            for (const result of canceled) if (result.status === "rejected" && !forced) errors.push(result.reason);
            await agent.close();
          } catch (error) {
            if (!forced) errors.push(error);
            await agent.destroy().catch((failure) => { errors.push(failure); });
          } finally {
            clearTimeout(timeout);
            await destroying;
            responses.clear();
            await running.close().catch((error) => { errors.push(error); });
          }
          if (errors.length) throw new AggregateError(errors, "HTTP fixture cleanup failed");
        })();
      },
    };
  }
  let current = await generation(options.port ?? 0);
  let operation = Promise.resolve();
  let closed = false;
  function enqueue(task: () => Promise<void>): Promise<void> {
    const result = operation.then(task);
    operation = result.catch(() => {});
    return result;
  }
  return {
    get current() { return current; },
    restart() {
      if (closed) return Promise.reject(new Error("HTTP fixture is closed"));
      return enqueue(async () => {
        const port = Number(new URL(current.baseUrl).port);
        await current.close();
        current = await generation(port);
      });
    },
    close() {
      closed = true;
      return enqueue(() => current.close());
    },
  };
}
