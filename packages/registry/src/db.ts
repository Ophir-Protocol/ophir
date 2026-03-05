import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { ServiceOffering, NegotiationCapability } from '@ophirai/sdk';

export interface AgentRow {
  id: number;
  agent_id: string;
  endpoint: string;
  name: string;
  description: string;
  services: ServiceOffering[];
  capabilities: NegotiationCapability;
  registered_at: string;
  last_heartbeat: string;
  status: 'active' | 'stale' | 'removed';
  reputation?: ReputationRow;
}

export interface ReputationRow {
  agent_id: string;
  total_agreements: number;
  completed_agreements: number;
  disputes_won: number;
  disputes_lost: number;
  avg_response_time_ms: number;
  score: number;
}

interface RawAgentRow {
  id: number;
  agent_id: string;
  endpoint: string;
  name: string;
  description: string;
  services: string;
  capabilities: string;
  registered_at: string;
  last_heartbeat: string;
  status: string;
  rep_score?: number | null;
  rep_total_agreements?: number | null;
  rep_completed_agreements?: number | null;
  rep_disputes_won?: number | null;
  rep_disputes_lost?: number | null;
  rep_avg_response_time_ms?: number | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT UNIQUE NOT NULL,
    endpoint TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    services TEXT NOT NULL DEFAULT '[]',
    capabilities TEXT NOT NULL DEFAULT '{}',
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'stale', 'removed'))
  );

  CREATE TABLE IF NOT EXISTS reputation (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    total_agreements INTEGER NOT NULL DEFAULT 0,
    completed_agreements INTEGER NOT NULL DEFAULT 0,
    disputes_won INTEGER NOT NULL DEFAULT 0,
    disputes_lost INTEGER NOT NULL DEFAULT 0,
    avg_response_time_ms REAL NOT NULL DEFAULT 0,
    score REAL NOT NULL DEFAULT 50
  );

  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    challenge TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  CREATE INDEX IF NOT EXISTS idx_agents_services ON agents(services);
  CREATE INDEX IF NOT EXISTS idx_challenges_agent ON challenges(agent_id);
`;

export class RegistryDB {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  registerAgent(
    agentId: string,
    endpoint: string,
    name: string,
    description: string,
    services: ServiceOffering[],
    capabilities: NegotiationCapability,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO agents (agent_id, endpoint, name, description, services, capabilities)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        endpoint = excluded.endpoint,
        name = excluded.name,
        description = excluded.description,
        services = excluded.services,
        capabilities = excluded.capabilities,
        last_heartbeat = datetime('now'),
        status = 'active'
    `);
    stmt.run(agentId, endpoint, name, description, JSON.stringify(services), JSON.stringify(capabilities));

    // Ensure a reputation row exists
    this.db.prepare(`
      INSERT OR IGNORE INTO reputation (agent_id) VALUES (?)
    `).run(agentId);
  }

  findAgents(query: {
    category?: string;
    maxPrice?: string;
    currency?: string;
    minReputation?: number;
    limit?: number;
  }): AgentRow[] {
    const conditions: string[] = ["a.status = 'active'"];
    const params: unknown[] = [];

    if (query.category) {
      conditions.push("a.services LIKE ?");
      params.push(`%"category":"${query.category}"%`);
    }

    if (query.minReputation !== undefined) {
      conditions.push("r.score >= ?");
      params.push(query.minReputation);
    }

    const join = query.minReputation !== undefined
      ? 'JOIN reputation r ON r.agent_id = a.agent_id'
      : 'LEFT JOIN reputation r ON r.agent_id = a.agent_id';

    const limit = query.limit ?? 50;

    const sql = `
      SELECT
        a.id, a.agent_id, a.endpoint, a.name, a.description,
        a.services, a.capabilities, a.registered_at, a.last_heartbeat, a.status,
        r.score AS rep_score,
        r.total_agreements AS rep_total_agreements,
        r.completed_agreements AS rep_completed_agreements,
        r.disputes_won AS rep_disputes_won,
        r.disputes_lost AS rep_disputes_lost,
        r.avg_response_time_ms AS rep_avg_response_time_ms
      FROM agents a
      ${join}
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.score DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as RawAgentRow[];

    let results = rows.map(rowToAgentRow);

    // Post-filter for maxPrice since SQLite JSON support is limited
    if (query.maxPrice) {
      const max = parseFloat(query.maxPrice);
      const cur = query.currency;
      results = results.filter((agent) =>
        agent.services.some((s) => {
          if (cur && s.currency !== cur) return false;
          return parseFloat(s.base_price) <= max;
        }),
      );
    }

    return results;
  }

  heartbeat(agentId: string): boolean {
    const result = this.db.prepare(`
      UPDATE agents SET last_heartbeat = datetime('now'), status = 'active'
      WHERE agent_id = ? AND status != 'removed'
    `).run(agentId);
    return result.changes > 0;
  }

  removeAgent(agentId: string): boolean {
    const result = this.db.prepare(`
      UPDATE agents SET status = 'removed' WHERE agent_id = ?
    `).run(agentId);
    return result.changes > 0;
  }

  getAgent(agentId: string): AgentRow | undefined {
    const row = this.db.prepare(`
      SELECT
        a.id, a.agent_id, a.endpoint, a.name, a.description,
        a.services, a.capabilities, a.registered_at, a.last_heartbeat, a.status,
        r.score AS rep_score,
        r.total_agreements AS rep_total_agreements,
        r.completed_agreements AS rep_completed_agreements,
        r.disputes_won AS rep_disputes_won,
        r.disputes_lost AS rep_disputes_lost,
        r.avg_response_time_ms AS rep_avg_response_time_ms
      FROM agents a
      LEFT JOIN reputation r ON r.agent_id = a.agent_id
      WHERE a.agent_id = ?
    `).get(agentId) as RawAgentRow | undefined;

    return row ? rowToAgentRow(row) : undefined;
  }

  markStaleAgents(staleAfterMinutes = 30): number {
    const result = this.db.prepare(`
      UPDATE agents SET status = 'stale'
      WHERE status = 'active'
        AND datetime(last_heartbeat, '+' || ? || ' minutes') < datetime('now')
    `).run(staleAfterMinutes);
    return result.changes;
  }

  createChallenge(agentId: string): string {
    const challenge = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '');
    this.db.prepare(`
      INSERT INTO challenges (agent_id, challenge, expires_at) VALUES (?, ?, ?)
    `).run(agentId, challenge, expiresAt);
    return challenge;
  }

  getActiveChallenges(agentId: string): string[] {
    const rows = this.db.prepare(`
      SELECT challenge FROM challenges
      WHERE agent_id = ? AND datetime(expires_at) > datetime('now')
      ORDER BY created_at DESC
    `).all(agentId) as { challenge: string }[];
    return rows.map((r) => r.challenge);
  }

  verifyChallenge(agentId: string, challenge: string): boolean {
    const row = this.db.prepare(`
      DELETE FROM challenges
      WHERE agent_id = ? AND challenge = ? AND datetime(expires_at) > datetime('now')
      RETURNING id
    `).get(agentId, challenge) as { id: number } | undefined;
    return row !== undefined;
  }

  getReputation(agentId: string): ReputationRow | undefined {
    return this.db.prepare(`
      SELECT * FROM reputation WHERE agent_id = ?
    `).get(agentId) as ReputationRow | undefined;
  }

  updateReputation(agentId: string, updates: Partial<ReputationRow>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'agent_id') continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }

    if (fields.length === 0) return;

    values.push(agentId);
    this.db.prepare(`
      UPDATE reputation SET ${fields.join(', ')} WHERE agent_id = ?
    `).run(...values);
  }

  close(): void {
    this.db.close();
  }
}

function rowToAgentRow(row: RawAgentRow): AgentRow {
  const agent: AgentRow = {
    id: row.id,
    agent_id: row.agent_id,
    endpoint: row.endpoint,
    name: row.name,
    description: row.description,
    services: JSON.parse(row.services) as ServiceOffering[],
    capabilities: JSON.parse(row.capabilities) as NegotiationCapability,
    registered_at: row.registered_at,
    last_heartbeat: row.last_heartbeat,
    status: row.status as AgentRow['status'],
  };

  if (row.rep_score != null) {
    agent.reputation = {
      agent_id: row.agent_id,
      total_agreements: row.rep_total_agreements ?? 0,
      completed_agreements: row.rep_completed_agreements ?? 0,
      disputes_won: row.rep_disputes_won ?? 0,
      disputes_lost: row.rep_disputes_lost ?? 0,
      avg_response_time_ms: row.rep_avg_response_time_ms ?? 0,
      score: row.rep_score,
    };
  }

  return agent;
}
