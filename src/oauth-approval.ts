import { randomBytes } from "node:crypto";

import { tokensEqual } from "./auth.js";

export interface ApprovalDetails {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  state?: string;
}

export interface ApprovalSummary extends Omit<ApprovalDetails, "codeChallenge" | "state"> {
  number: string;
  expiresAt: number;
}

interface PendingApproval {
  details: ApprovalDetails;
  summary: ApprovalSummary;
  secret: string;
  decision?: { approved: boolean; at: number };
}

export type ApprovalResult =
  | { status: "invalid" }
  | { status: "pending"; summary: ApprovalSummary }
  | { status: "denied" }
  | { status: "approved"; details: ApprovalDetails; approvedAt: number; number: string };

/** Owns immutable request binding, expiry, and single-use browser delivery. */
export class ApprovalRequests {
  private readonly requests = new Map<string, PendingApproval>();
  private inspected: PendingApproval | undefined;

  create(details: ApprovalDetails): { id: string; secret: string; expiresAt: number } {
    this.pruneExpired();
    const id = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 120_000;
    let number: string;
    do {
      number = randomBytes(5).toString("hex").toUpperCase();
    } while ([...this.requests.values()].some((request) => request.summary.number === number));
    this.requests.set(id, {
      secret,
      details: structuredClone(details),
      summary: {
        clientId: details.clientId,
        clientName: details.clientName,
        redirectUri: details.redirectUri,
        resource: details.resource,
        scopes: [...details.scopes],
        number,
        expiresAt,
      },
    });
    return { id, secret, expiresAt };
  }

  inspect(number: string): ApprovalSummary | undefined {
    const request = this.findPending(number);
    this.inspected = request;
    return request ? structuredClone(request.summary) : undefined;
  }

  decide(number: string, approved: boolean): boolean {
    const request = this.findPending(number);
    if (!request || request !== this.inspected) return false;
    this.inspected = undefined;
    request.decision = { approved, at: Date.now() };
    return true;
  }

  inspectedSummary(number: string): ApprovalSummary | undefined {
    const request = this.findPending(number);
    return request && request === this.inspected ? structuredClone(request.summary) : undefined;
  }

  consume(id: string, secret: string): ApprovalResult {
    const request = this.requests.get(id);
    if (!request || !tokensEqual(secret, request.secret)) return { status: "invalid" };
    if (request.summary.expiresAt <= Date.now()) {
      this.requests.delete(id);
      return { status: "invalid" };
    }
    if (!request.decision) {
      return { status: "pending", summary: structuredClone(request.summary) };
    }
    this.requests.delete(id);
    return request.decision.approved
      ? { status: "approved", details: request.details, approvedAt: request.decision.at, number: request.summary.number }
      : { status: "denied" };
  }

  clear(): void {
    this.requests.clear();
    this.inspected = undefined;
  }

  private findPending(number: string): PendingApproval | undefined {
    this.pruneExpired();
    return [...this.requests.values()].find((request) =>
      request.summary.number === number && !request.decision);
  }

  private pruneExpired(): void {
    for (const [id, request] of this.requests) {
      if (request.summary.expiresAt <= Date.now()) this.requests.delete(id);
    }
  }
}
