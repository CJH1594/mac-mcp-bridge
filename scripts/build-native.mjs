import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const root = new URL("../", import.meta.url);
  const output = new URL("dist/src/native/", root);
  await mkdir(output, { recursive: true });
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  const result = spawnSync("/usr/bin/xcrun", [
    "swiftc", "-parse-as-library", "-O", "-target", `${architecture}-apple-macos14.0`,
    fileURLToPath(new URL("src/native/screen-capture.swift", root)),
    "-o", fileURLToPath(new URL("screen-capture", output)),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
