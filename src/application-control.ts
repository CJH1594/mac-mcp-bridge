import type { AppConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import type { ApprovalSummary } from "./oauth-approval.js";
import type { ApprovedSession } from "./oauth-store.js";
import { RemoteDevOAuthProvider } from "./oauth.js";
import type { ProcessManager } from "./process-manager.js";

export interface LocalControl {
  inspectApproval(number: string): ApprovalSummary | undefined;
  decideApproval(number: string, approved: boolean): Promise<boolean>;
  getApprovedSession(): Promise<ApprovedSession | undefined>;
  resetSessionTime(): Promise<boolean>;
  disconnect(): Promise<void>;
  stopAccess(): Promise<void>;
}

/** Owns admission, request lifetime, and the distinct meanings of close and stop. */
export class ApplicationControl implements LocalControl {
  readonly oauthProvider: RemoteDevOAuthProvider | undefined;
  private state: "running" | "closed" | "stopped" = "running";
  private readonly requests = new Set<() => Promise<void>>();
  private stopPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(config: AppConfig, private readonly processes: ProcessManager) {
    this.oauthProvider = config.oauthEnabled
      ? new RemoteDevOAuthProvider(config, () => !this.accessStopped)
      : undefined;
  }

  get accessStopped(): boolean {
    return this.state !== "running";
  }

  get activeRequests(): number {
    return this.requests.size;
  }

  inspectApproval(number: string): ApprovalSummary | undefined {
    return this.accessStopped ? undefined : this.oauthProvider?.approvals.inspect(number);
  }

  async decideApproval(number: string, approved: boolean): Promise<boolean> {
    return !this.accessStopped && (await this.oauthProvider?.decideApproval(number, approved) ?? false);
  }

  async getApprovedSession(): Promise<ApprovedSession | undefined> {
    return this.accessStopped ? undefined : this.oauthProvider?.clientsStore.getApprovedSession();
  }

  async resetSessionTime(): Promise<boolean> {
    return !this.accessStopped && (await this.oauthProvider?.clientsStore.resetSessionTime() ?? false);
  }

  trackRequest(close: () => Promise<void>): () => Promise<void> {
    if (this.accessStopped) throw new Error("Access has been stopped");
    let pending: Promise<void> | undefined;
    const finish = (): Promise<void> => {
      pending ??= Promise.resolve().then(close).then(
        () => { this.requests.delete(finish); },
        (error) => { pending = undefined; throw error; },
      );
      return pending;
    };
    this.requests.add(finish);
    return finish;
  }

  stopAccess(): Promise<void> {
    if (this.state !== "closed") this.state = "stopped";
    this.stopPromise ??= this.finishWork(true).catch((error) => {
      // A failed attempt must not reopen admission or poison later retries.
      this.stopPromise = undefined;
      throw error;
    });
    return this.stopPromise;
  }

  async disconnect(): Promise<void> {
    await this.stopAccess();
    if (this.state !== "stopped") return;
    this.processes.resumeAfterShutdown();
    this.stopPromise = undefined;
    this.state = "running";
  }

  close(): Promise<void> {
    this.state = "closed";
    this.closePromise ??= this.finishWork(false).catch((error) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  private async finishWork(revoke: boolean): Promise<void> {
    const results = await Promise.allSettled([
      revoke ? this.oauthProvider?.revokeAll() : undefined,
      this.processes.shutdown(),
      ...[...this.requests].map((finish) => finish()),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      const errors = failures.map((result) => result.reason);
      throw new AggregateError(errors, `Access stopped, but cleanup failed: ${errors.map(errorMessage).join("; ")}`);
    }
  }
}
