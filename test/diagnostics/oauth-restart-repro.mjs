import { spawn } from "node:child_process";

const iterations = Number(process.argv.slice(2).find((argument) => /^\d+$/.test(argument)) || 20);
if (process.argv.includes("--pooled")) throw new Error("Use legacy-http-restart.mjs to reproduce the old global-pool behavior");
if (iterations < 1) throw new Error("Iteration count must be positive");
let next = 0;
let failed = 0;
async function worker() {
  while (next < iterations) {
    const index = ++next;
    await new Promise((resolve) => {
      const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "test/oauth.integration.test.ts"], {
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("exit", (code) => {
        if (code !== 0) {
          failed++;
          const signal = output.split("\n").filter((line) => /HTTP (GET|POST|DELETE)|ECONNRESET|UND_ERR_SOCKET|fetch failed|Caused by:/.test(line));
          console.log(`Run ${index}: FAIL ${signal.join(" | ")}`);
        }
        resolve();
      });
    });
  }
}
await Promise.all([worker(), worker()]);
console.log(`OAuth restart reproduction: ${failed}/${iterations} failed`);
process.exitCode = failed ? 1 : 0;
