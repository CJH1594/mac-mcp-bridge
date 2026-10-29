#!/usr/bin/env node
// Test-only stand-in: a long-running git apply with an observable readiness marker.
import { writeFileSync } from "node:fs";

if (process.argv[2] !== "apply" || !process.env.TEST_GIT_READY) process.exit(2);
writeFileSync(process.env.TEST_GIT_READY, String(process.pid));
setInterval(() => {}, 1000);
