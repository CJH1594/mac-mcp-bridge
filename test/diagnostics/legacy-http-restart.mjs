import { createServer } from "node:http";

// Deliberately reproduces the old, unowned global fetch pool. Never used by fixtures.
const iterations = Number(process.argv[2] || 40);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error("Iteration count must be positive");
let port = 0;
async function start() {
  const server = createServer((request, response) => {
    response.writeHead(request.method === "POST" ? 401 : 200).end("{}");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  port = server.address().port;
  return server;
}
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
let server = await start();
let failures = 0;
try {
  for (let attempt = 0; attempt < iterations; attempt++) {
    await (await fetch(`http://127.0.0.1:${port}/health`)).arrayBuffer();
    await close(server);
    server = await start();
    try {
      await (await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" })).arrayBuffer();
    } catch (error) {
      failures++;
      console.log(`POST /mcp: ${error.cause?.code ?? error.name}`);
    }
  }
} finally {
  await close(server);
}
console.log(`Legacy global-pool restart: ${failures}/${iterations} failed`);
process.exitCode = failures ? 1 : 0;
