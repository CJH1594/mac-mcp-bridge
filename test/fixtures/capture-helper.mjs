#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const request = JSON.parse(process.argv[2]);
await writeFile(process.env.CAPTURE_FIXTURE_RECORD, JSON.stringify({ ...request, pid: process.pid }));
if (process.env.CAPTURE_FIXTURE_MODE === "hang") {
  setInterval(() => {}, 1000);
} else if (process.env.CAPTURE_FIXTURE_MODE === "denied") {
  console.log(JSON.stringify({ error: "Enable screen recording permission", code: "capture_permission_denied" }));
} else if (request.operation === "list") {
  console.log(JSON.stringify({ displays: [{ id: 7, width: 100, height: 80, scale: 2 }], windows: [{ id: 11, title: "Fixture window" }] }));
} else {
  await writeFile(request.outputPath, await readFile(process.env.CAPTURE_FIXTURE_PNG));
  console.log(JSON.stringify({ target: request.target }));
}
