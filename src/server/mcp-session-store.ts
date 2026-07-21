import type {
  McpSessionRejectionReason,
  StoredMcpSession,
  WorkspaceRepository,
} from "./workspace-repository.js";

export type McpSessionStoreKind = "memory" | "postgres";

export interface CreateMcpSessionInput {
  sessionIdHash: string;
  workspaceId: string;
  principalId: string;
  protocolVersion: string;
}

export interface FindMcpSessionInput {
  sessionIdHash: string;
  workspaceId: string;
  principalId: string;
}

export interface McpSessionStore {
  readonly kind: McpSessionStoreKind;
  create(input: CreateMcpSessionInput): Promise<StoredMcpSession | null>;
  getAuthorized(input: FindMcpSessionInput): Promise<StoredMcpSession | null>;
  touch(input: FindMcpSessionInput): Promise<StoredMcpSession | null>;
  classifyRejection(input: FindMcpSessionInput): Promise<McpSessionRejectionReason>;
  close(input: FindMcpSessionInput): Promise<boolean>;
  pruneExpired(limit?: number): Promise<number>;
  countActive(): Promise<number>;
  statistics(): Promise<{ active: number; expired: number; closed: number }>;
}

export class PostgresMcpSessionStore implements McpSessionStore {
  readonly kind = "postgres" as const;

  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly idleTtlMs: number,
    private readonly maxSessions: number,
  ) {}

  create(input: CreateMcpSessionInput): Promise<StoredMcpSession | null> {
    return this.repository.createMcpSession({
      ...input,
      idleTtlMs: this.idleTtlMs,
      maxSessions: this.maxSessions,
    });
  }

  getAuthorized(input: FindMcpSessionInput): Promise<StoredMcpSession | null> {
    return this.repository.getAuthorizedMcpSession({
      ...input,
      idleTtlMs: this.idleTtlMs,
    });
  }

  touch(input: FindMcpSessionInput): Promise<StoredMcpSession | null> {
    return this.repository.touchMcpSession({ ...input, idleTtlMs: this.idleTtlMs });
  }

  classifyRejection(input: FindMcpSessionInput): Promise<McpSessionRejectionReason> {
    return this.repository.classifyMcpSessionRejection({
      ...input,
      idleTtlMs: this.idleTtlMs,
    });
  }

  close(input: FindMcpSessionInput): Promise<boolean> {
    return this.repository.closeMcpSession(input);
  }

  pruneExpired(limit?: number): Promise<number> {
    return this.repository.pruneExpiredMcpSessions(this.idleTtlMs, limit);
  }

  countActive(): Promise<number> {
    return this.repository.countActiveMcpSessions(this.idleTtlMs);
  }

  statistics(): Promise<{ active: number; expired: number; closed: number }> {
    return this.repository.getMcpSessionStatistics(this.idleTtlMs);
  }
}

export class MemoryMcpSessionStore implements McpSessionStore {
  readonly kind = "memory" as const;
  private readonly sessions = new Map<string, StoredMcpSession>();

  constructor(
    private readonly idleTtlMs: number,
    private readonly maxSessions: number,
  ) {}

  async create(input: CreateMcpSessionInput): Promise<StoredMcpSession | null> {
    await this.pruneExpired();
    if (this.sessions.has(input.sessionIdHash) || await this.countActive() >= this.maxSessions) {
      return null;
    }
    const now = new Date().toISOString();
    const session: StoredMcpSession = {
      ...input,
      status: "active",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.sessionIdHash, session);
    return session;
  }

  async getAuthorized(input: FindMcpSessionInput): Promise<StoredMcpSession | null> {
    const session = this.sessions.get(input.sessionIdHash);
    if (
      !session ||
      session.workspaceId !== input.workspaceId ||
      session.principalId !== input.principalId ||
      session.status !== "active" ||
      Date.now() - Date.parse(session.lastSeenAt) >= this.idleTtlMs
    ) {
      return null;
    }
    return { ...session };
  }

  async touch(input: FindMcpSessionInput): Promise<StoredMcpSession | null> {
    const session = await this.getAuthorized(input);
    if (!session) return null;
    const now = new Date().toISOString();
    session.lastSeenAt = now;
    session.updatedAt = now;
    this.sessions.set(session.sessionIdHash, session);
    return { ...session };
  }

  async classifyRejection(
    input: FindMcpSessionInput,
  ): Promise<McpSessionRejectionReason> {
    const session = this.sessions.get(input.sessionIdHash);
    if (!session) return "unknown";
    if (
      session.workspaceId !== input.workspaceId ||
      session.principalId !== input.principalId
    ) {
      return "principal_mismatch";
    }
    if (session.status !== "active") return "closed";
    return Date.now() - Date.parse(session.lastSeenAt) >= this.idleTtlMs
      ? "expired"
      : "unknown";
  }

  async close(input: FindMcpSessionInput): Promise<boolean> {
    const session = this.sessions.get(input.sessionIdHash);
    if (
      !session ||
      session.workspaceId !== input.workspaceId ||
      session.principalId !== input.principalId ||
      session.status === "closed"
    ) {
      return false;
    }
    session.status = "closed";
    session.updatedAt = new Date().toISOString();
    return true;
  }

  async pruneExpired(limit = 256): Promise<number> {
    const now = Date.now();
    let deleted = 0;
    for (const [sessionIdHash, session] of this.sessions) {
      const basis = session.status === "active" ? session.lastSeenAt : session.updatedAt;
      if (now - Date.parse(basis) < this.idleTtlMs) continue;
      this.sessions.delete(sessionIdHash);
      deleted += 1;
      if (deleted >= limit) break;
    }
    return deleted;
  }

  async countActive(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const session of this.sessions.values()) {
      if (
        session.status === "active" &&
        now - Date.parse(session.lastSeenAt) < this.idleTtlMs
      ) {
        count += 1;
      }
    }
    return count;
  }

  async statistics(): Promise<{ active: number; expired: number; closed: number }> {
    const now = Date.now();
    let active = 0;
    let expired = 0;
    let closed = 0;
    for (const session of this.sessions.values()) {
      if (session.status !== "active") {
        closed += 1;
      } else if (now - Date.parse(session.lastSeenAt) >= this.idleTtlMs) {
        expired += 1;
      } else {
        active += 1;
      }
    }
    return { active, expired, closed };
  }
}
