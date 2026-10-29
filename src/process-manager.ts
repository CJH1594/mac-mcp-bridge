import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAscii } from "node:buffer";

import { errorMessage } from "./errors.js";

const OUTPUT_CHUNK_BYTES = 16 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function groupHasNoLiveMembers(pgid: number): boolean {
  try {
    const listing = execFileSync("/bin/ps", ["-axo", "pgid=,stat="], { encoding: "utf8", timeout: 1000 });
    return !listing.split("\n").some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pgid && !state?.startsWith("Z");
    });
  } catch {
    return false;
  }
}

export type ProcessOutputStream = "stdout" | "stderr";

interface OutputChunk {
  seq: number;
  stream: ProcessOutputStream;
  data: Buffer;
}

interface Termination {
  deadline: number;
  timer: NodeJS.Timeout | undefined;
  forceSent: boolean;
  failed: boolean;
  finished: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ManagedProcess {
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number | undefined;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  error: string | undefined;
  timedOut: boolean;
  chunks: OutputChunk[];
  pendingOutput: Record<ProcessOutputStream, Buffer>;
  retainedBytes: number;
  totalOutputBytes: number;
  droppedOutputBytes: number;
  nextSeq: number;
  waiters: Set<() => void>;
  exitWaiters: Set<() => void>;
  timeoutHandle: NodeJS.Timeout | undefined;
  retentionHandle: NodeJS.Timeout | undefined;
  cleanup: (() => Promise<void>) | undefined;
  cleanupPromise: Promise<void> | undefined;
  termination: Termination | undefined;
}

function isContinuationByte(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}

function utf8SequenceLengthAt(
  data: Buffer,
  offset: number,
  final: boolean,
): number | undefined {
  const first = data[offset]!;
  if (first <= 0x7f) {
    return 1;
  }

  let length = 0;
  if (first >= 0xc2 && first <= 0xdf) {
    length = 2;
  } else if (first >= 0xe0 && first <= 0xef) {
    length = 3;
  } else if (first >= 0xf0 && first <= 0xf4) {
    length = 4;
  } else {
    return 1;
  }

  if (offset + 1 >= data.length) {
    return final ? 1 : undefined;
  }

  const second = data[offset + 1]!;
  if (!isContinuationByte(second)) {
    return 1;
  }
  if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second > 0x9f)) {
    return 1;
  }
  if ((first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) {
    return 1;
  }
  for (let index = 2; index < length; index += 1) {
    if (offset + index >= data.length) {
      return final ? 1 : undefined;
    }
    if (!isContinuationByte(data[offset + index]!)) {
      return 1;
    }
  }
  return length;
}

function splitOutputChunks(
  data: Buffer,
  final = false,
): { chunks: Buffer[]; remainder: Buffer } {
  if (isAscii(data)) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < data.length; offset += OUTPUT_CHUNK_BYTES) {
      chunks.push(Buffer.from(data.subarray(offset, offset + OUTPUT_CHUNK_BYTES)));
    }
    return { chunks, remainder: Buffer.alloc(0) };
  }

  const chunks: Buffer[] = [];
  let chunkStart = 0;
  let cursor = 0;
  while (cursor < data.length) {
    const sequenceLength = utf8SequenceLengthAt(data, cursor, final);
    if (sequenceLength === undefined) {
      break;
    }
    if (
      cursor > chunkStart &&
      cursor + sequenceLength - chunkStart > OUTPUT_CHUNK_BYTES
    ) {
      chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
      chunkStart = cursor;
      continue;
    }
    cursor += sequenceLength;
    if (cursor - chunkStart === OUTPUT_CHUNK_BYTES) {
      chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
      chunkStart = cursor;
    }
  }
  if (cursor > chunkStart) {
    chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
  }
  return {
    chunks,
    remainder: Buffer.from(data.subarray(cursor)),
  };
}

export interface StartProcessRequest {
  executable: string;
  args: string[];
  commandForDisplay: string;
  cwd: string;
  env?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  stdin?: string | undefined;
  closeStdin?: boolean | undefined;
  cleanup?: (() => Promise<void>) | undefined;
}

export interface ReadProcessRequest {
  afterSeq?: number | undefined;
  waitMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  view?: "since" | "tail" | "failure";
}

export interface ProcessReadResult {
  sessionId: string;
  command: string;
  cwd: string;
  running: boolean;
  pid: number | undefined;
  startedAt: string;
  endedAt: string | undefined;
  wallTimeMs: number;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  timedOut: boolean;
  error: string | undefined;
  stdout: string;
  stderr: string;
  output: string;
  nextSeq: number;
  hasMore: boolean;
  totalOutputBytes: number;
  droppedOutputBytes: number;
  view: "since" | "tail" | "failure";
  returnedRanges: Array<{ fromSeq: number; toSeq: number }>;
  omittedBefore: boolean;
  omittedBetween: boolean;
  omittedAfter: boolean;
  firstAvailableSeq: number;
  cursorGap: boolean;
}

export interface ProcessManagerOptions {
  maxRetainedOutputBytes: number;
  processRetentionMs: number;
  maxProcesses: number;
  defaultMaxOutputBytes: number;
  maxOutputBytes?: number;
}

export class ProcessManager {
  #stopped = false;
  #shutdownPromise: Promise<void> | undefined;
  #shutdownComplete = false;
  #generation = 0;
  readonly #processes = new Map<string, ManagedProcess>();
  readonly #pendingCleanup = new Set<ManagedProcess>();
  readonly #pendingTerminations = new Set<ManagedProcess>();
  readonly #options: ProcessManagerOptions;

  constructor(options: ProcessManagerOptions) {
    this.#options = options;
  }

  /** Bind delayed startup to the connection that admitted it. */
  captureStart(): (request: StartProcessRequest) => string {
    if (this.#stopped) throw new Error("Process execution has been stopped");
    const generation = this.#generation;
    return (request) => {
      if (generation !== this.#generation) throw new Error("The originating connection has been disconnected");
      return this.start(request);
    };
  }

  start(request: StartProcessRequest): string {
    if (this.#stopped) throw new Error("Process execution has been stopped");
    this.prune();
    this.#makeCapacity();

    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const sessionId = randomUUID();
    const managed: ManagedProcess = {
      sessionId,
      child,
      command: request.commandForDisplay,
      cwd: request.cwd,
      startedAt: Date.now(),
      endedAt: undefined,
      exitCode: undefined,
      signal: undefined,
      error: undefined,
      timedOut: false,
      chunks: [],
      pendingOutput: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      retainedBytes: 0,
      totalOutputBytes: 0,
      droppedOutputBytes: 0,
      nextSeq: 1,
      waiters: new Set(),
      exitWaiters: new Set(),
      timeoutHandle: undefined,
      retentionHandle: undefined,
      cleanup: request.cleanup,
      cleanupPromise: undefined,
      termination: undefined,
    };
    this.#processes.set(sessionId, managed);

    child.stdout.on("data", (data: Buffer | string) => {
      this.#appendOutput(managed, "stdout", Buffer.from(data));
    });
    child.stderr.on("data", (data: Buffer | string) => {
      this.#appendOutput(managed, "stderr", Buffer.from(data));
    });
    child.stdin.on("error", (error) => {
      this.#recordStdinError(managed, error);
    });
    child.on("error", (error) => {
      managed.error = errorMessage(error);
      this.#finish(managed, null, null);
    });
    child.on("close", (code, signal) => {
      this.#finish(managed, code, signal);
    });
    child.on("exit", () => {
      // Finish this requested group termination now; do not leave a delayed
      // signal aimed at a numeric process-group ID after the parent exits.
      this.#forceTermination(managed);
    });

    const timeoutMs = request.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      managed.timeoutHandle = setTimeout(() => {
        managed.timedOut = true;
        managed.error ??= `Process exceeded timeout of ${timeoutMs} ms`;
        this.#beginTermination(managed, "SIGTERM", 5000);
      }, timeoutMs);
      managed.timeoutHandle.unref();
    }

    if (request.stdin !== undefined && request.stdin.length > 0) {
      try {
        child.stdin.write(request.stdin, (error) => {
          if (error) {
            this.#recordStdinError(managed, error);
          }
        });
      } catch (error) {
        this.#recordStdinError(managed, error);
      }
    }
    if (request.closeStdin) child.stdin.end();
    return sessionId;
  }

  async read(
    sessionId: string,
    request: ReadProcessRequest = {},
  ): Promise<ProcessReadResult> {
    const managed = this.#require(sessionId);
    const afterSeq = Math.max(0, request.afterSeq ?? 0);
    const view = request.view ?? "since";
    const waitMs = Math.max(0, request.waitMs ?? 0);
    if (waitMs > 0 && view === "since") {
      await this.#waitForOutput(managed, afterSeq, waitMs);
    }

    const maxOutputBytes = Math.max(
      OUTPUT_CHUNK_BYTES,
      Math.min(
        request.maxOutputBytes ?? this.#options.defaultMaxOutputBytes,
        this.#options.maxOutputBytes ?? this.#options.defaultMaxOutputBytes,
      ),
    );
    const eligible = managed.chunks.filter((chunk) => chunk.seq > afterSeq);
    const selected: OutputChunk[] = [];
    let selectedBytes = 0;
    if (view === "since") {
      for (const chunk of eligible) {
        if (selectedBytes + chunk.data.length > maxOutputBytes) break;
        selected.push(chunk);
        selectedBytes += chunk.data.length;
      }
    } else {
      const selectedSeq = new Set<number>();
      const takeTail = (chunks: OutputChunk[], budget: number) => {
        for (let i = chunks.length - 1; i >= 0; i--) {
          const chunk = chunks[i]!;
          if (selectedSeq.has(chunk.seq)) continue;
          if (chunk.data.length > budget) break;
          selected.push(chunk); selectedSeq.add(chunk.seq);
          selectedBytes += chunk.data.length; budget -= chunk.data.length;
        }
      };
      if (view === "failure") takeTail(managed.chunks.filter((chunk) => chunk.stream === "stderr"), Math.max(OUTPUT_CHUNK_BYTES, Math.floor(maxOutputBytes / 2)));
      takeTail(managed.chunks, maxOutputBytes - selectedBytes);
      selected.sort((a, b) => a.seq - b.seq);
    }
    const returnedRanges: Array<{ fromSeq: number; toSeq: number }> = [];
    for (const chunk of selected) {
      const previous = returnedRanges.at(-1);
      if (previous && previous.toSeq + 1 === chunk.seq) previous.toSeq = chunk.seq;
      else returnedRanges.push({ fromSeq: chunk.seq, toSeq: chunk.seq });
    }

    const stdout = Buffer.concat(
      selected.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.data),
    ).toString("utf8");
    const stderr = Buffer.concat(
      selected.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.data),
    ).toString("utf8");
    const output = Buffer.concat(selected.map((chunk) => chunk.data)).toString("utf8");
    const nextSeq = view === "since" ? selected.at(-1)?.seq ?? afterSeq : afterSeq;
    const now = managed.endedAt ?? Date.now();

    return {
      sessionId,
      command: managed.command,
      cwd: managed.cwd,
      running: this.#isRunning(managed),
      pid: managed.child.pid,
      startedAt: new Date(managed.startedAt).toISOString(),
      endedAt:
        managed.endedAt === undefined
          ? undefined
          : new Date(managed.endedAt).toISOString(),
      wallTimeMs: now - managed.startedAt,
      exitCode: managed.exitCode,
      signal: managed.signal,
      timedOut: managed.timedOut,
      error: managed.error,
      stdout,
      stderr,
      output,
      nextSeq,
      hasMore: (view === "since" ? eligible : managed.chunks).length > selected.length,
      totalOutputBytes: managed.totalOutputBytes,
      droppedOutputBytes: managed.droppedOutputBytes,
      view, returnedRanges,
      omittedBefore: !!selected.length && selected[0]!.seq > (managed.chunks[0]?.seq ?? 0),
      omittedBetween: returnedRanges.length > 1,
      omittedAfter: !!selected.length && selected.at(-1)!.seq < (managed.chunks.at(-1)?.seq ?? 0),
      firstAvailableSeq: managed.chunks[0]?.seq ?? managed.nextSeq,
      cursorGap: afterSeq + 1 < (managed.chunks[0]?.seq ?? managed.nextSeq),
    };
  }

  async write(
    sessionId: string,
    input: string,
    closeStdin = false,
  ): Promise<void> {
    const managed = this.#require(sessionId);
    if (input.length === 0 && !closeStdin) {
      return;
    }
    if (!this.#isRunning(managed)) {
      throw new Error(`Process ${sessionId} is not running`);
    }
    if (managed.child.stdin.destroyed || !managed.child.stdin.writable) {
      throw new Error(`stdin is closed for process ${sessionId}`);
    }

    if (input.length > 0) {
      await new Promise<void>((resolve, reject) => {
        managed.child.stdin.write(input, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
    if (closeStdin) {
      managed.child.stdin.end();
    }
  }

  async waitForExit(sessionId: string, waitMs: number): Promise<void> {
    const managed = this.#require(sessionId);
    if (!this.#isRunning(managed) || waitMs <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        managed.exitWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      managed.exitWaiters.add(finish);
      if (!this.#isRunning(managed)) {
        finish();
      }
    });
  }

  async terminate(
    sessionId: string,
    signal: NodeJS.Signals = "SIGTERM",
    graceMs = 3000,
  ): Promise<ProcessReadResult> {
    const managed = this.#require(sessionId);
    if (this.#isRunning(managed)) {
      if (signal === "SIGKILL" || graceMs > 0) this.#beginTermination(managed, signal, graceMs);
      else this.#signal(managed, signal);
    }
    return this.read(sessionId, { waitMs: Math.min(graceMs, 1000) });
  }

  list(): Array<{
    sessionId: string;
    pid: number | undefined;
    command: string;
    cwd: string;
    running: boolean;
    startedAt: string;
    endedAt: string | undefined;
    exitCode: number | null | undefined;
  }> {
    return [...this.#processes.values()].map((managed) => ({
      sessionId: managed.sessionId,
      pid: managed.child.pid,
      command: managed.command,
      cwd: managed.cwd,
      running: this.#isRunning(managed),
      startedAt: new Date(managed.startedAt).toISOString(),
      endedAt:
        managed.endedAt === undefined
          ? undefined
          : new Date(managed.endedAt).toISOString(),
      exitCode: managed.exitCode,
    }));
  }

  prune(): void {
    const cutoff = Date.now() - this.#options.processRetentionMs;
    for (const managed of this.#processes.values()) {
      if (managed.endedAt !== undefined && managed.endedAt < cutoff) {
        this.#forget(managed);
      }
    }
  }

  shutdown(): Promise<void> {
    if (!this.#stopped) this.#generation++;
    this.#stopped = true;
    this.#shutdownPromise ??= this.#shutdownWork().then(() => {
      this.#shutdownComplete = true;
    }).catch((error) => {
      this.#shutdownPromise = undefined;
      throw error;
    });
    return this.#shutdownPromise;
  }

  /** Start a new connection's work only after the previous connection was fully cleaned up. */
  resumeAfterShutdown(): void {
    if (!this.#shutdownComplete) throw new Error("Managed work cleanup must finish before resuming");
    for (const managed of this.#processes.values()) this.#forget(managed);
    this.#shutdownComplete = false;
    this.#shutdownPromise = undefined;
    this.#stopped = false;
  }

  async #shutdownWork(): Promise<void> {
    const running = [...this.#processes.values()].filter((managed) =>
      this.#isRunning(managed),
    );
    const pending = new Set([...running, ...this.#pendingTerminations]);
    const terminations = await Promise.allSettled([...pending].map((managed) => this.#beginTermination(managed, "SIGTERM", 500)));
    const errors: unknown[] = terminations.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    const completed = [...this.#pendingCleanup];
    const results = await Promise.allSettled(completed.map((managed) => this.#cleanup(managed)));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        completed[index]!.cleanupPromise = undefined;
        errors.push(result.reason);
      }
    });
    if (errors.length) {
      throw new AggregateError(errors, `Managed work cleanup failed: ${errors.map(errorMessage).join("; ")}`);
    }
  }

  #makeCapacity(): void {
    if (this.#processes.size < this.#options.maxProcesses) {
      return;
    }
    const completed = [...this.#processes.values()]
      .filter((managed) => managed.endedAt !== undefined)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    while (
      this.#processes.size >= this.#options.maxProcesses &&
      completed.length > 0
    ) {
      const managed = completed.shift();
      if (managed) {
        this.#forget(managed);
      }
    }
    if (this.#processes.size >= this.#options.maxProcesses) {
      throw new Error(
        `Maximum managed process count (${this.#options.maxProcesses}) reached`,
      );
    }
  }

  #require(sessionId: string): ManagedProcess {
    const managed = this.#processes.get(sessionId);
    if (!managed) {
      throw new Error(`Unknown process session: ${sessionId}`);
    }
    return managed;
  }

  #appendOutput(
    managed: ManagedProcess,
    stream: ProcessOutputStream,
    data: Buffer,
  ): void {
    managed.totalOutputBytes += data.length;
    const pending = managed.pendingOutput[stream];
    const combined = pending.length > 0 ? Buffer.concat([pending, data]) : data;
    const split = splitOutputChunks(combined);
    managed.pendingOutput[stream] = split.remainder;
    this.#storeOutputChunks(managed, stream, split.chunks);
    this.#trimRetainedOutput(managed);
    this.#notify(managed);
  }

  #storeOutputChunks(
    managed: ManagedProcess,
    stream: ProcessOutputStream,
    chunks: Buffer[],
  ): void {
    for (const data of chunks) {
      managed.chunks.push({ seq: managed.nextSeq, stream, data });
      managed.nextSeq += 1;
      managed.retainedBytes += data.length;
    }
  }

  #trimRetainedOutput(managed: ManagedProcess): void {
    while (
      managed.retainedBytes > this.#options.maxRetainedOutputBytes &&
      managed.chunks.length > 0
    ) {
      const removed = managed.chunks.shift();
      if (removed) {
        managed.retainedBytes -= removed.data.length;
        managed.droppedOutputBytes += removed.data.length;
      }
    }
  }

  #flushPendingOutput(managed: ManagedProcess): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const pending = managed.pendingOutput[stream];
      if (pending.length === 0) {
        continue;
      }
      const split = splitOutputChunks(pending, true);
      managed.pendingOutput[stream] = Buffer.alloc(0);
      this.#storeOutputChunks(managed, stream, split.chunks);
    }
    this.#trimRetainedOutput(managed);
  }

  #recordStdinError(managed: ManagedProcess, error: unknown): void {
    managed.error ??= `stdin write failed: ${errorMessage(error)}`;
    this.#notify(managed);
  }

  #finish(
    managed: ManagedProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (managed.endedAt !== undefined) {
      return;
    }
    this.#flushPendingOutput(managed);
    managed.endedAt = Date.now();
    managed.exitCode = code;
    managed.signal = signal;
    if (managed.termination) {
      this.#forceTermination(managed);
      if (!managed.termination?.failed) this.#completeTermination(managed);
    }
    if (managed.timeoutHandle) {
      clearTimeout(managed.timeoutHandle);
      managed.timeoutHandle = undefined;
    }
    this.#notify(managed);
    const exitWaiters = [...managed.exitWaiters];
    managed.exitWaiters.clear();
    for (const waiter of exitWaiters) {
      waiter();
    }
    if (managed.cleanup) {
      this.#pendingCleanup.add(managed);
      void this.#cleanup(managed).catch(() => {});
    }
    this.#scheduleRetention(managed);
  }

  #cleanup(managed: ManagedProcess): Promise<void> {
    if (!managed.cleanup) return Promise.resolve();
    managed.cleanupPromise ??= Promise.resolve().then(managed.cleanup).then(() => {
      managed.cleanup = undefined;
      this.#pendingCleanup.delete(managed);
    }).catch((error) => {
      managed.error ??= `Cleanup failed: ${errorMessage(error)}`;
      throw error;
    });
    return managed.cleanupPromise;
  }

  #scheduleRetention(managed: ManagedProcess): void {
    const expiresAt = (managed.endedAt ?? Date.now()) + this.#options.processRetentionMs;
    const expireOrReschedule = () => {
      managed.retentionHandle = undefined;
      if (this.#processes.get(managed.sessionId) !== managed) {
        return;
      }
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        this.#processes.delete(managed.sessionId);
        return;
      }
      managed.retentionHandle = setTimeout(
        expireOrReschedule,
        Math.min(remainingMs, MAX_TIMER_DELAY_MS),
      );
      managed.retentionHandle.unref();
    };
    managed.retentionHandle = setTimeout(
      expireOrReschedule,
      Math.min(this.#options.processRetentionMs, MAX_TIMER_DELAY_MS),
    );
    managed.retentionHandle.unref();
  }

  #forget(managed: ManagedProcess): void {
    if (managed.retentionHandle) {
      clearTimeout(managed.retentionHandle);
      managed.retentionHandle = undefined;
    }
    if (this.#processes.get(managed.sessionId) === managed) {
      this.#processes.delete(managed.sessionId);
    }
  }

  #notify(managed: ManagedProcess): void {
    const waiters = [...managed.waiters];
    managed.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  #waitForOutput(
    managed: ManagedProcess,
    afterSeq: number,
    waitMs: number,
  ): Promise<void> {
    if (managed.nextSeq - 1 > afterSeq || !this.#isRunning(managed)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        managed.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      managed.waiters.add(finish);
      if (managed.nextSeq - 1 > afterSeq || !this.#isRunning(managed)) {
        finish();
      }
    });
  }

  #isRunning(managed: ManagedProcess): boolean {
    return managed.endedAt === undefined;
  }

  #beginTermination(managed: ManagedProcess, signal: NodeJS.Signals, graceMs: number): Promise<void> {
    let termination = managed.termination;
    if (!termination || termination.failed) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const finished = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      // Automatic timeout and individual terminate report errors through read().
      // Keep the original rejection available for shutdown to join safely.
      void finished.catch(() => {});
      termination = { deadline: performance.now() + graceMs, timer: undefined, forceSent: false, failed: false, finished, resolve, reject };
      managed.termination = termination;
      this.#pendingTerminations.add(managed);
    }
    if (termination.forceSent) return termination.finished;
    if (signal === "SIGKILL") {
      this.#forceTermination(managed);
    } else {
      this.#signal(managed, signal);
      termination.deadline = Math.min(termination.deadline, performance.now() + graceMs);
      clearTimeout(termination.timer);
      if (managed.endedAt !== undefined || managed.child.exitCode !== null || managed.child.signalCode !== null) {
        this.#forceTermination(managed);
      } else {
        termination.timer = setTimeout(() => this.#forceTermination(managed), Math.max(0, termination.deadline - performance.now()));
        termination.timer.unref();
      }
    }
    return termination.finished;
  }

  #forceTermination(managed: ManagedProcess): void {
    const termination = managed.termination;
    if (!termination || termination.forceSent) return;
    clearTimeout(termination.timer);
    termination.timer = undefined;
    termination.forceSent = true;
    if (process.platform !== "win32" || (managed.child.exitCode === null && managed.child.signalCode === null)) {
      const error = this.#signal(managed, "SIGKILL");
      if (error) {
        termination.failed = true;
        termination.reject(error);
        return;
      }
    }
    if (managed.endedAt !== undefined) this.#completeTermination(managed);
  }

  #completeTermination(managed: ManagedProcess): void {
    managed.termination?.resolve();
    managed.termination = undefined;
    this.#pendingTerminations.delete(managed);
  }

  #signal(managed: ManagedProcess, signal: NodeJS.Signals): Error | undefined {
    const pid = managed.child.pid;
    if (pid === undefined) {
      return;
    }
    try {
      if (process.platform !== "win32") {
        process.kill(-pid, signal);
      } else {
        managed.child.kill(signal);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Darwin can return EPERM for a disappearing, zombie-only group.
      // A live group (or a failed inspection) must still report permission failure.
      if (code === "EPERM" && process.platform === "darwin" && groupHasNoLiveMembers(pid)) return;
      if (code !== "ESRCH") {
        const failure = new Error(`Failed to signal process: ${errorMessage(error)}`, { cause: error });
        managed.error ??= failure.message;
        return failure;
      }
    }
  }
}
