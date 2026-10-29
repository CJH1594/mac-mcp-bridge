import { execFileSync } from "node:child_process";
import { ProcessManager } from "../../src/process-manager.ts";

const iterations = Number(process.argv[2] || 100);
const kill = process.kill.bind(process);
let failures = 0;
process.kill = (pid, signal) => {
  try { return kill(pid, signal); } catch (error) {
    if (pid < 0 && error.code !== "ESRCH") {
      let probe;
      try { kill(pid, 0); probe = "exists"; } catch (failure) { probe = failure.code; }
      let groups;
      try {
        groups = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", timeout: 1000 })
          .trim().split("\n").map((line) => line.trim().split(/\s+/)).filter((fields) => Number(fields[2]) === -pid);
      } catch (failure) { groups = `unavailable: ${failure.code}`; }
      console.log(JSON.stringify({ signal, code: error.code, pgid: -pid, probe, members: groups }));
    }
    throw error;
  }
};
try {
  for (let attempt = 0; attempt < iterations; attempt++) {
    const manager = new ProcessManager({
      maxRetainedOutputBytes: 1024, processRetentionMs: 1000, maxProcesses: 16, defaultMaxOutputBytes: 1024,
    });
    const session = manager.start({
      executable: "/bin/bash", args: ["-c", "exec 0<&-; printf ready; sleep 2"],
      commandForDisplay: "closed stdin", cwd: process.cwd(),
    });
    await manager.read(session, { waitMs: 1000 });
    await manager.write(session, "x".repeat(1024 * 1024)).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    try { await manager.shutdown(); } catch {
      failures++;
      await manager.shutdown().catch(() => {});
    }
  }
} finally {
  process.kill = kill;
}
console.log(`Process signal reproduction: ${failures}/${iterations} failed`);
