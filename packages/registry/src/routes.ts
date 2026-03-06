import express from 'express';
import type { RegistryDB, AgentRow, ReputationRow } from './db.js';
import type { AuthMiddleware } from './auth.js';
import type { AgentCard } from '@ophirai/sdk';
import { computeReputationScore } from './reputation.js';

function agentToResponse(agent: AgentRow) {
  return {
    agentId: agent.agent_id,
    endpoint: agent.endpoint,
    name: agent.name,
    description: agent.description,
    services: agent.services,
    capabilities: agent.capabilities,
    registeredAt: agent.registered_at,
    lastHeartbeat: agent.last_heartbeat,
    status: agent.status,
    reputation: agent.reputation
      ? {
          score: agent.reputation.score,
          total_agreements: agent.reputation.total_agreements,
          disputes_won: agent.reputation.disputes_won,
          disputes_lost: agent.reputation.disputes_lost,
        }
      : undefined,
  };
}

export function createRouter(db: RegistryDB, auth: AuthMiddleware): express.Router {
  const router = express.Router();

  // POST /agents — Register an agent (requires auth)
  router.post('/agents', auth.requireAuth, (req, res) => {
    const agentId = req.agentId!;
    const card = req.body as AgentCard;

    if (!card.name || !card.url) {
      res.status(400).json({ success: false, error: 'Missing required fields: name, url' });
      return;
    }

    const neg = card.capabilities?.negotiation;
    const services = neg?.services ?? [];
    const capabilities = neg ?? {};

    db.registerAgent(
      agentId,
      neg?.endpoint ?? card.url,
      card.name,
      card.description ?? '',
      services.map((s) => ({
        category: s.category,
        description: s.description,
        base_price: s.base_price,
        currency: s.currency,
        unit: s.unit,
      })),
      capabilities as AgentCard['capabilities']['negotiation'] & {},
    );

    const agent = db.getAgent(agentId);
    res.status(201).json({
      success: true,
      data: { agent_id: agentId, registered_at: agent?.registered_at ?? new Date().toISOString() },
    });
  });

  // GET /agents — Find agents (public)
  router.get('/agents', (req, res) => {
    const query = {
      category: req.query.category as string | undefined,
      maxPrice: req.query.max_price as string | undefined,
      currency: req.query.currency as string | undefined,
      minReputation: req.query.min_reputation ? Number(req.query.min_reputation) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    };

    const agents = db.findAgents(query);
    res.json({
      success: true,
      data: { agents: agents.map(agentToResponse) },
    });
  });

  // GET /agents/:agentId — Get agent details (public)
  router.get('/agents/:agentId', (req, res) => {
    const agent = db.getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ success: false, error: 'Agent not found' });
      return;
    }
    res.json({ success: true, data: agentToResponse(agent) });
  });

  // POST /agents/:agentId/heartbeat — Keep alive (requires auth, must match)
  router.post('/agents/:agentId/heartbeat', auth.requireAuth, (req, res) => {
    if (req.agentId !== req.params.agentId) {
      res.status(403).json({ success: false, error: 'Agent ID mismatch' });
      return;
    }

    const ok = db.heartbeat(req.params.agentId);
    if (!ok) {
      res.status(404).json({ success: false, error: 'Agent not found' });
      return;
    }

    res.json({ success: true, data: { status: 'ok', last_heartbeat: new Date().toISOString() } });
  });

  // DELETE /agents/:agentId — Unregister (requires auth, must match)
  router.delete('/agents/:agentId', auth.requireAuth, (req, res) => {
    if (req.agentId !== req.params.agentId) {
      res.status(403).json({ success: false, error: 'Agent ID mismatch' });
      return;
    }

    db.removeAgent(req.params.agentId);
    res.status(204).send();
  });

  // POST /auth/challenge — Get a challenge for authentication (public)
  router.post('/auth/challenge', auth.challengeHandler);

  // POST /reputation/:agentId — Report outcome (requires auth, counterparty only)
  router.post('/reputation/:agentId', auth.requireAuth, (req, res) => {
    const targetAgentId = req.params.agentId;

    // The reporter must NOT be the target agent (counterparty reports)
    if (req.agentId === targetAgentId) {
      res.status(403).json({ success: false, error: 'Cannot report on yourself' });
      return;
    }

    const { agreement_id, outcome, response_time_ms } = req.body as {
      agreement_id?: string;
      outcome?: 'completed' | 'disputed_won' | 'disputed_lost';
      response_time_ms?: number;
    };

    if (!agreement_id || typeof agreement_id !== 'string') {
      res.status(400).json({ success: false, error: 'Missing required field: agreement_id' });
      return;
    }

    if (!outcome || !['completed', 'disputed_won', 'disputed_lost'].includes(outcome)) {
      res.status(400).json({ success: false, error: 'Invalid outcome' });
      return;
    }

    // Check for duplicate report (same reporter + target + agreement)
    if (db.hasReputationReport(req.agentId!, targetAgentId, agreement_id)) {
      res.status(409).json({ success: false, error: 'Duplicate report for this agreement' });
      return;
    }

    const rep = db.getReputation(targetAgentId);
    if (!rep) {
      res.status(404).json({ success: false, error: 'Agent not found' });
      return;
    }

    const updates: Partial<ReputationRow> = {
      total_agreements: rep.total_agreements + 1,
    };

    if (outcome === 'completed') {
      updates.completed_agreements = rep.completed_agreements + 1;
    } else if (outcome === 'disputed_won') {
      updates.disputes_won = rep.disputes_won + 1;
    } else if (outcome === 'disputed_lost') {
      updates.disputes_lost = rep.disputes_lost + 1;
    }

    if (response_time_ms !== undefined && response_time_ms >= 0) {
      const totalTime = rep.avg_response_time_ms * rep.total_agreements;
      updates.avg_response_time_ms = (totalTime + response_time_ms) / (rep.total_agreements + 1);
    }

    // Record the report to prevent duplicates
    db.insertReputationReport(req.agentId!, targetAgentId, agreement_id, outcome);

    // Apply updates, then recompute score
    db.updateReputation(targetAgentId, updates);

    const updatedRep = db.getReputation(targetAgentId)!;
    const newScore = computeReputationScore(updatedRep);
    db.updateReputation(targetAgentId, { score: newScore });

    const finalRep = db.getReputation(targetAgentId)!;
    res.json({ success: true, data: finalRep });
  });

  return router;
}
