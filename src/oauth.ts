import { randomBytes } from "node:crypto";

import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Request, Response } from "express";

import { tokensEqual } from "./auth.js";
import type { AppConfig } from "./config.js";
import { OAUTH_SCOPES } from "./tool-metadata.js";
import { ApprovalRequests, type ApprovalDetails } from "./oauth-approval.js";
import { PersistentOAuthStore } from "./oauth-store.js";
import { renderAuthorizationPage, renderTerminalApprovalPage } from "./oauth-pages.js";

export { OAUTH_SCOPES };

interface AuthorizationCodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
  sessionExpiresAt: number;
  sessionId?: string;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export class RemoteDevOAuthProvider implements OAuthServerProvider {
  readonly approvals = new ApprovalRequests();
  readonly clientsStore: PersistentOAuthStore;
  readonly issuerUrl: URL;
  readonly resourceUrl: URL;
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();

  constructor(
    private readonly config: AppConfig,
    private readonly acceptsRequests: () => boolean = () => true,
  ) {
    if (!config.oauthIssuerUrl || !config.oauthResourceUrl ||
      (config.oauthApprovalMode === "key" && !config.oauthApprovalKey)) {
      throw new Error("OAuth configuration is incomplete");
    }
    this.issuerUrl = new URL(config.oauthIssuerUrl);
    this.resourceUrl = new URL(config.oauthResourceUrl);
    this.clientsStore = new PersistentOAuthStore(
      config.oauthStateFile,
      config.oauthAccessTokenTtlSeconds,
      config.oauthRefreshTokenTtlSeconds,
      config.oauthSessionTtlSeconds,
      config.oauthApprovalMode === "terminal",
    );
  }

  private validateResource(resource: URL | undefined): string {
    if (!resource || resource.href !== this.resourceUrl.href) {
      throw new InvalidTargetError(`resource must be ${this.resourceUrl.href}`);
    }
    return resource.href;
  }

  private validateScopes(scopes: string[] | undefined): string[] {
    const requested = scopes && scopes.length > 0 ? [...new Set(scopes)] : [...OAUTH_SCOPES];
    if (!requested.every((scope) => OAUTH_SCOPES.includes(scope as (typeof OAUTH_SCOPES)[number]))) {
      throw new InvalidScopeError("Only the mcp:tools scope is supported");
    }
    return requested;
  }

  private pruneAuthorizationCodes(): void {
    const now = Date.now();
    for (const [code, record] of this.authorizationCodes) {
      if (record.expiresAt <= now) {
        this.authorizationCodes.delete(code);
      }
    }
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: Response,
  ): Promise<void> {
    if (!this.acceptsRequests()) {
      response.status(503).json({ error: "access_stopped" });
      return;
    }
    if (!(client.grant_types ?? ["authorization_code"]).includes("authorization_code")) {
      throw new UnauthorizedClientError("Client is not authorized for authorization_code");
    }
    const resource = this.validateResource(params.resource);
    const scopes = this.validateScopes(params.scopes);
    const details: ApprovalDetails = {
      clientId: client.client_id,
      clientName: client.client_name || "MCP client",
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      resource,
      scopes,
      state: params.state,
    };
    if (this.config.oauthApprovalMode === "terminal") {
      const pending = this.approvals.create(details);
      const approvalPath = `/oauth/approval/${pending.id}`;
      response.cookie("cokac_approval", pending.secret, {
        httpOnly: true,
        secure: this.issuerUrl.protocol === "https:",
        sameSite: "lax",
        path: approvalPath,
        maxAge: Math.max(0, pending.expiresAt - Date.now()),
      });
      response.redirect(303, approvalPath);
      return;
    }
    const request = response.req as Request;
    const accessKey =
      request.method === "POST" && typeof request.body?.access_key === "string"
        ? request.body.access_key
        : undefined;

    const redirectOrigin = new URL(params.redirectUri).origin;
    response.set({
      "Content-Security-Policy":
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; base-uri 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });

    if (!accessKey || !tokensEqual(accessKey, this.config.oauthApprovalKey!)) {
      response
        .status(accessKey ? 401 : 200)
        .type("html")
        .send(renderAuthorizationPage(client, { ...params, scopes, resource: new URL(resource) }, Boolean(accessKey)));
      return;
    }

    this.redirectWithCode(details, Date.now(), response);
  }

  async decideApproval(number: string, approved: boolean): Promise<boolean> {
    const summary = this.approvals.inspectedSummary(number);
    if (!this.acceptsRequests() || !summary) return false;
    if (!approved) return this.approvals.decide(number, false);
    const session = await this.clientsStore.reserveSession(summary);
    if (!session) return false;
    if (!this.acceptsRequests() || !this.approvals.decide(number, true)) {
      await this.clientsStore.releaseSession(session.id);
      return false;
    }
    return true;
  }

  async completeTerminalApproval(request: Request, response: Response): Promise<void> {
    if (!this.acceptsRequests()) {
      response.status(503).json({ error: "access_stopped" });
      return;
    }
    response.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    const cookie = request.headers.cookie?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("cokac_approval="))
      ?.slice("cokac_approval=".length) || "";
    const result = this.approvals.consume(String(request.params.id), cookie);
    if (result.status === "invalid" || result.status === "denied") {
      response.status(result.status === "invalid" ? 410 : 403)
        .type("html").send("승인 요청이 만료되었거나 거절되었습니다. 연결을 다시 시작해 주세요.");
      return;
    }
    if (result.status === "pending") {
      response.type("html").send(renderTerminalApprovalPage(result.summary));
      return;
    }
    const session = await this.clientsStore.getApprovedSession();
    if (!this.acceptsRequests() || !session || session.number !== result.number ||
      session.clientId !== result.details.clientId) {
      response.status(410).type("html").send("승인된 연결이 만료되었거나 중단되었습니다.");
      return;
    }
    this.redirectWithCode(result.details, result.approvedAt, response, session);
  }

  private redirectWithCode(details: ApprovalDetails, approvedAt: number, response: Response,
    session?: { id: string; expiresAt: number }): void {
    this.pruneAuthorizationCodes();
    const code = randomToken();
    this.authorizationCodes.set(code, {
      clientId: details.clientId,
      codeChallenge: details.codeChallenge,
      redirectUri: details.redirectUri,
      resource: details.resource,
      scopes: details.scopes,
      expiresAt: Date.now() + this.config.oauthAuthorizationCodeTtlSeconds * 1000,
      sessionExpiresAt: session?.expiresAt ?? approvedAt + this.config.oauthSessionTtlSeconds * 1000,
      sessionId: session?.id,
    });
    const target = new URL(details.redirectUri);
    target.searchParams.set("code", code);
    if (details.state !== undefined) target.searchParams.set("state", details.state);
    response.redirect(303, target.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    if (!this.acceptsRequests()) throw new InvalidGrantError("Access has been stopped");
    this.pruneAuthorizationCodes();
    const record = this.authorizationCodes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (!this.acceptsRequests()) throw new InvalidGrantError("Access has been stopped");
    this.pruneAuthorizationCodes();
    const record = this.authorizationCodes.get(authorizationCode);
    if (
      !record ||
      record.clientId !== client.client_id ||
      record.redirectUri !== redirectUri ||
      record.resource !== this.validateResource(resource)
    ) {
      throw new InvalidGrantError("Invalid authorization code binding");
    }
    this.authorizationCodes.delete(authorizationCode);
    try {
      return await this.clientsStore.issueTokenPair(
        client.client_id,
        record.scopes,
        record.resource,
        client.grant_types?.includes("refresh_token") ?? false,
        record.sessionExpiresAt,
        record.sessionId,
      );
    } catch (error) {
      if (record.expiresAt > Date.now() && !this.authorizationCodes.has(authorizationCode)) {
        this.authorizationCodes.set(authorizationCode, record);
      }
      throw error;
    }
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (!this.acceptsRequests()) throw new InvalidGrantError("Access has been stopped");
    if (!client.grant_types?.includes("refresh_token")) {
      throw new UnauthorizedClientError("Client is not authorized for refresh_token");
    }
    const resourceValue = this.validateResource(resource);
    const requestedScopes = scopes ? this.validateScopes(scopes) : undefined;
    const result = await this.clientsStore.rotateRefreshToken(
      refreshToken,
      client.client_id,
      resourceValue,
      requestedScopes,
    );
    if (result.status === "invalid_scope") {
      throw new InvalidScopeError("Refresh scope exceeds the original grant");
    }
    if (result.status === "invalid") {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    return result.tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = await this.clientsStore.getAccessToken(token);
    if (!stored || stored.resource !== this.resourceUrl.href) {
      throw new InvalidGrantError("Invalid or expired access token");
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt / 1000),
      resource: new URL(stored.resource),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await this.clientsStore.revoke(request.token, client.client_id);
  }

  async revokeAll(): Promise<void> {
    this.approvals.clear();
    this.authorizationCodes.clear();
    await this.clientsStore.revokeAll();
  }
}
