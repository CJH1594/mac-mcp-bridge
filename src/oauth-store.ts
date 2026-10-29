import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import { OAUTH_SCOPES } from "./tool-metadata.js";
import type { ApprovalSummary } from "./oauth-approval.js";

export interface ApprovedSession {
  id: string;
  number: string;
  clientId: string;
  clientName: string;
  name?: string;
  expiresAt: number;
}

interface StoredToken {
  type: "access" | "refresh" | "used_refresh";
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource: string;
  grantId?: string;
  // Legacy records lack this field and cannot authorize a request or refresh.
  sessionExpiresAt?: number;
}

interface PersistedOAuthState {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  tokens: Record<string, StoredToken>;
  approvedSession?: ApprovedSession;
}


type RefreshResult =
  | { status: "invalid" }
  | { status: "invalid_scope" }
  | { status: "ok"; tokens: OAuthTokens };

function emptyState(): PersistedOAuthState {
  return { version: 1, clients: {}, tokens: {} };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

const LOOPBACK_REDIRECT_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SUPPORTED_CLIENT_AUTH_METHODS = new Set(["none", "client_secret_post"]);
const SUPPORTED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);

function clientMetadataProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Client metadata must be an object";
  }
  const client = value as Partial<OAuthClientInformationFull>;
  if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length === 0) {
    return "At least one redirect_uri is required";
  }
  for (const redirectUri of client.redirect_uris) {
    if (typeof redirectUri !== "string") {
      return "Every redirect_uri must be an absolute URL";
    }
    let parsed: URL;
    try {
      parsed = new URL(redirectUri);
    } catch {
      return "Every redirect_uri must be an absolute URL";
    }
    const isLoopback = LOOPBACK_REDIRECT_HOSTS.has(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
      return "Every redirect_uri must use HTTPS or HTTP on a loopback host";
    }
    if (parsed.hash || parsed.username || parsed.password) {
      return "redirect_uris must not contain fragments or user credentials";
    }
  }

  if (
    client.token_endpoint_auth_method !== undefined &&
    typeof client.token_endpoint_auth_method !== "string"
  ) {
    return "token_endpoint_auth_method must be a string";
  }
  const authMethod = client.token_endpoint_auth_method ?? "client_secret_post";
  if (!SUPPORTED_CLIENT_AUTH_METHODS.has(authMethod)) {
    return `Unsupported token_endpoint_auth_method: ${authMethod}`;
  }

  if (
    client.grant_types !== undefined &&
    (!Array.isArray(client.grant_types) ||
      !client.grant_types.every((grantType) => typeof grantType === "string"))
  ) {
    return "grant_types must be an array of strings";
  }
  const grantTypes = client.grant_types ?? ["authorization_code"];
  if (
    grantTypes.length === 0 ||
    !grantTypes.includes("authorization_code") ||
    !grantTypes.every((grantType) => SUPPORTED_GRANT_TYPES.has(grantType))
  ) {
    return "grant_types must contain authorization_code and may contain refresh_token";
  }

  if (
    client.response_types !== undefined &&
    (!Array.isArray(client.response_types) ||
      !client.response_types.every((responseType) => typeof responseType === "string"))
  ) {
    return "response_types must be an array of strings";
  }
  const responseTypes = client.response_types ?? ["code"];
  if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
    return "Only the code response_type is supported";
  }

  if (client.scope !== undefined && typeof client.scope !== "string") {
    return "scope must be a string";
  }
  const scopes = client.scope?.split(/\s+/).filter(Boolean) ?? [];
  if (!scopes.every((scope) => OAUTH_SCOPES.includes(scope as (typeof OAUTH_SCOPES)[number]))) {
    return "Only the mcp:tools scope is supported";
  }
  return undefined;
}

function isStoredToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== "object") {
    return false;
  }
  const token = value as Partial<StoredToken>;
  return (
    (token.type === "access" || token.type === "refresh" || token.type === "used_refresh") &&
    typeof token.clientId === "string" &&
    Array.isArray(token.scopes) &&
    token.scopes.every((scope) => typeof scope === "string") &&
    typeof token.expiresAt === "number" &&
    typeof token.resource === "string" &&
    (token.grantId === undefined || typeof token.grantId === "string") &&
    (token.sessionExpiresAt === undefined ||
      (typeof token.sessionExpiresAt === "number" && Number.isFinite(token.sessionExpiresAt))) &&
    (token.type !== "used_refresh" || typeof token.grantId === "string")
  );
}

function parseState(value: string): PersistedOAuthState {
  const parsed = JSON.parse(value) as Partial<PersistedOAuthState>;
  if (
    parsed.version !== 1 ||
    !parsed.clients ||
    typeof parsed.clients !== "object" ||
    Array.isArray(parsed.clients) ||
    !parsed.tokens ||
    typeof parsed.tokens !== "object" ||
    Array.isArray(parsed.tokens) ||
    !Object.values(parsed.tokens).every(isStoredToken) ||
    (parsed.approvedSession !== undefined && !isApprovedSession(parsed.approvedSession))
  ) {
    throw new Error("Invalid OAuth state file format");
  }
  return parsed as PersistedOAuthState;
}

function isApprovedSession(value: unknown): value is ApprovedSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ApprovedSession>;
  return typeof session.id === "string" && typeof session.number === "string" &&
    typeof session.clientId === "string" && typeof session.clientName === "string" &&
    typeof session.expiresAt === "number" && Number.isFinite(session.expiresAt) &&
    (session.name === undefined || typeof session.name === "string");
}

export class PersistentOAuthStore implements OAuthRegisteredClientsStore {
  private state = emptyState();
  private loadPromise: Promise<void> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateFile: string,
    private readonly accessTokenTtlSeconds: number,
    private readonly refreshTokenTtlSeconds: number,
    private readonly sessionTtlSeconds = 6 * 60 * 60,
    private readonly singleSession = false,
  ) {}

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= (async () => {
      try {
        this.state = parseState(await readFile(this.stateFile, "utf8"));
        if (this.singleSession && !this.state.approvedSession) {
          // Adopt the longest-lived existing grant when upgrading an older state file.
          const existing = Object.values(this.state.tokens)
            .filter((token) => token.type !== "used_refresh" && token.grantId &&
              token.expiresAt > Date.now() && (token.sessionExpiresAt ?? 0) > Date.now())
            .sort((a, b) => b.sessionExpiresAt! - a.sessionExpiresAt! || a.grantId!.localeCompare(b.grantId!))[0];
          if (existing) this.state.approvedSession = {
            id: existing.grantId!, number: existing.grantId!.slice(0, 10).toUpperCase(),
            clientId: existing.clientId,
            clientName: this.state.clients[existing.clientId]?.client_name || "MCP client",
            expiresAt: existing.sessionExpiresAt!,
          };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    })();
    await this.loadPromise;
  }

  private pruneExpired(): void {
    const now = Date.now();
    if (this.state.approvedSession && this.state.approvedSession.expiresAt <= now) {
      delete this.state.approvedSession;
    }
    for (const [hash, token] of Object.entries(this.state.tokens)) {
      if (token.expiresAt <= now || !token.sessionExpiresAt || token.sessionExpiresAt <= now ||
        (this.singleSession && token.grantId !== this.state.approvedSession?.id)) {
        delete this.state.tokens[hash];
      }
    }
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.stateFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryFile, `${JSON.stringify(this.state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryFile, this.stateFile);
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      throw error;
    }
  }

  private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.ensureLoaded();
    const pending = this.mutationQueue.then(async () => {
      const snapshot = structuredClone(this.state);
      try {
        this.pruneExpired();
        const result = await operation();
        await this.persist();
        return result;
      } catch (error) {
        this.state = snapshot;
        throw error;
      }
    });
    this.mutationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const client = this.state.clients[clientId];
    if (!client || client.client_id !== clientId || clientMetadataProblem(client)) {
      return undefined;
    }
    return client;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const supplied = client as Partial<OAuthClientInformationFull>;
    const registered: OAuthClientInformationFull = {
      ...client,
      token_endpoint_auth_method:
        client.token_endpoint_auth_method ?? "client_secret_post",
      grant_types: client.grant_types ?? ["authorization_code"],
      response_types: client.response_types ?? ["code"],
      client_id: supplied.client_id || randomUUID(),
      client_id_issued_at: supplied.client_id_issued_at || Math.floor(Date.now() / 1000),
    };
    const problem = clientMetadataProblem(registered);
    if (problem) {
      throw new InvalidClientMetadataError(problem);
    }
    return this.mutate(() => {
      this.state.clients[registered.client_id] = registered;
      return registered;
    });
  }

  async issueTokenPair(
    clientId: string,
    scopes: string[],
    resource: string,
    issueRefreshToken = true,
    sessionExpiresAt = Date.now() + this.sessionTtlSeconds * 1000,
    approvedSessionId?: string,
  ): Promise<OAuthTokens> {
    return this.mutate(() => {
      const session = this.state.approvedSession;
      if (this.singleSession && (!session || session.id !== approvedSessionId ||
        session.clientId !== clientId)) {
        throw new InvalidGrantError("Only one approved connection is allowed");
      }
      return this.issueTokenPairWithoutPersist(
        clientId,
        scopes,
        resource,
        this.singleSession ? session!.id : randomUUID(),
        issueRefreshToken,
        this.singleSession ? session!.expiresAt : sessionExpiresAt,
      );
    });
  }

  async reserveSession(request: ApprovalSummary): Promise<ApprovedSession | undefined> {
    return this.mutate(() => {
      if (this.state.approvedSession) return undefined;
      const session: ApprovedSession = {
        id: randomUUID(), number: request.number, clientId: request.clientId,
        clientName: request.clientName, expiresAt: Date.now() + this.sessionTtlSeconds * 1000,
      };
      this.state.approvedSession = session;
      return structuredClone(session);
    });
  }

  async getApprovedSession(): Promise<ApprovedSession | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const session = this.state.approvedSession;
    return session && session.expiresAt > Date.now() ? structuredClone(session) : undefined;
  }

  async resetSessionTime(): Promise<boolean> {
    return this.mutate(() => {
      const session = this.state.approvedSession;
      if (!session) return false;
      session.expiresAt = Date.now() + 6 * 60 * 60 * 1000;
      for (const token of Object.values(this.state.tokens)) {
        if (token.grantId !== session.id) continue;
        token.sessionExpiresAt = session.expiresAt;
        if (token.type === "refresh") {
          token.expiresAt = Math.min(Date.now() + this.refreshTokenTtlSeconds * 1000, session.expiresAt);
        } else if (token.type === "used_refresh") {
          token.expiresAt = session.expiresAt;
        }
      }
      return true;
    });
  }

  async releaseSession(id: string): Promise<void> {
    await this.mutate(() => {
      if (this.state.approvedSession?.id === id) this.revokeGrantWithoutPersist(id);
    });
  }

  private issueTokenPairWithoutPersist(
    clientId: string,
    scopes: string[],
    resource: string,
    grantId: string,
    issueRefreshToken = true,
    sessionExpiresAt = Date.now() + this.sessionTtlSeconds * 1000,
  ): OAuthTokens {
    const accessToken = randomToken();
    const now = Date.now();
    const expiresIn = Math.min(this.accessTokenTtlSeconds, Math.floor((sessionExpiresAt - now) / 1000));
    if (expiresIn <= 0) throw new InvalidGrantError("The approved session has expired");
    this.state.tokens[tokenHash(accessToken)] = {
      type: "access",
      clientId,
      scopes,
      expiresAt: now + expiresIn * 1000,
      sessionExpiresAt,
      resource,
      grantId,
    };
    const tokens: OAuthTokens = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: scopes.join(" "),
    };
    if (issueRefreshToken) {
      const refreshToken = randomToken();
      this.state.tokens[tokenHash(refreshToken)] = {
        type: "refresh",
        clientId,
        scopes,
        expiresAt: Math.min(now + this.refreshTokenTtlSeconds * 1000, sessionExpiresAt),
        sessionExpiresAt,
        resource,
        grantId,
      };
      tokens.refresh_token = refreshToken;
    }
    return tokens;
  }

  private revokeGrantWithoutPersist(grantId: string, preserveReplayEvidence = false): void {
    if (this.state.approvedSession?.id === grantId) delete this.state.approvedSession;
    for (const [hash, token] of Object.entries(this.state.tokens)) {
      if (
        token.grantId === grantId &&
        !(preserveReplayEvidence && token.type === "used_refresh")
      ) {
        delete this.state.tokens[hash];
      }
    }
  }

  async rotateRefreshToken(
    refreshToken: string,
    clientId: string,
    resource: string,
    requestedScopes: string[] | undefined,
  ): Promise<RefreshResult> {
    return this.mutate(() => {
      const hash = tokenHash(refreshToken);
      const current = this.state.tokens[hash];
      if (
        !current ||
        current.clientId !== clientId ||
        current.resource !== resource ||
        current.expiresAt <= Date.now()
      ) {
        return { status: "invalid" };
      }
      if (current.type === "used_refresh") {
        this.revokeGrantWithoutPersist(current.grantId!, true);
        return { status: "invalid" };
      }
      if (current.type !== "refresh") {
        return { status: "invalid" };
      }
      const scopes = requestedScopes ?? current.scopes;
      if (!scopes.every((scope) => current.scopes.includes(scope))) {
        return { status: "invalid_scope" };
      }
      const grantId = current.grantId ?? randomUUID();
      this.state.tokens[hash] = {
        ...current, type: "used_refresh", grantId, expiresAt: current.sessionExpiresAt!,
      };
      return {
        status: "ok",
        tokens: this.issueTokenPairWithoutPersist(
          clientId, scopes, resource, grantId, true, current.sessionExpiresAt!,
        ),
      };
    });
  }

  async getAccessToken(token: string): Promise<StoredToken | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const stored = this.state.tokens[tokenHash(token)];
    if (!stored || stored.type !== "access" || stored.expiresAt <= Date.now() ||
      !stored.sessionExpiresAt || stored.sessionExpiresAt <= Date.now() ||
      (this.singleSession && stored.grantId !== (await this.getApprovedSession())?.id)) {
      return undefined;
    }
    const client = this.state.clients[stored.clientId];
    if (!client || clientMetadataProblem(client)) {
      return undefined;
    }
    return stored;
  }

  async revoke(token: string, clientId: string): Promise<void> {
    await this.mutate(() => {
      const hash = tokenHash(token);
      const stored = this.state.tokens[hash];
      if (stored?.clientId === clientId) {
        if (stored.grantId) {
          this.revokeGrantWithoutPersist(stored.grantId);
        } else {
          delete this.state.tokens[hash];
        }
      }
    });
  }

  async revokeAll(): Promise<void> {
    await this.mutate(() => { this.state.tokens = {}; delete this.state.approvedSession; });
  }
}
