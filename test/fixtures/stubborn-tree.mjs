import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--child")) {
  process.on("SIGTERM", () => {});
  process.send("ready");
  process.disconnect();
} else {
  if (process.argv.includes("--stubborn-parent")) process.on("SIGTERM", () => {});
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("message", () => console.log(child.pid));
}
setInterval(() => {}, 1000);
