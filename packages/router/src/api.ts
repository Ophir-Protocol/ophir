import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { OphirRouter } from './router.js';

export function createRouterAPI(router: OphirRouter): express.Router {
  const api = express.Router();

  // POST /v1/chat/completions
  api.post('/v1/chat/completions', async (req, res) => {
    try {
      const { model, messages, temperature, max_tokens, stream } = req.body;

      if (!messages || !Array.isArray(messages)) {
        res.status(400).json({
          error: { message: 'messages is required and must be an array', type: 'invalid_request_error' },
        });
        return;
      }

      const requestModel = model || 'auto';

      const result = await router.route({
        model: requestModel,
        messages,
        temperature,
        max_tokens,
        stream: stream ?? false,
      });

      // The provider response should already be OpenAI-shaped, but we enrich it
      const providerResponse = result.response as Record<string, unknown>;

      const response = {
        id: (providerResponse.id as string) || `chatcmpl-${uuidv4()}`,
        object: 'chat.completion',
        created: (providerResponse.created as number) || Math.floor(Date.now() / 1000),
        model: (providerResponse.model as string) || requestModel,
        choices: providerResponse.choices || [],
        usage: providerResponse.usage || null,
        ophir: {
          agreement_id: result.agreementId,
          provider: result.selectedQuote?.seller.agent_id ?? result.providerEndpoint,
          negotiated_price: result.selectedQuote?.pricing.price_per_unit ?? 'unknown',
          strategy: result.strategy,
          latency_ms: result.latencyMs,
        },
      };

      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('No providers available') || message.includes('No quotes available') ? 503 : 502;
      res.status(status).json({
        error: { message, type: 'router_error' },
      });
    }
  });

  // GET /v1/models
  api.get('/v1/models', (_req, res) => {
    // Aggregate models from monitored agreements and strategy context
    const monitor = router.getMonitor();
    const agreementIds = monitor.getAgreementIds();

    const models: Array<{ id: string; object: string; owned_by: string }> = [];
    const seen = new Set<string>();

    for (const id of agreementIds) {
      const sellerId = monitor.getSellerForAgreement(id);
      if (sellerId && !seen.has(sellerId)) {
        seen.add(sellerId);
        models.push({
          id: sellerId,
          object: 'model',
          owned_by: 'ophir',
        });
      }
    }

    // Always include the 'auto' model
    if (!seen.has('auto')) {
      models.unshift({ id: 'auto', object: 'model', owned_by: 'ophir' });
    }

    res.json({ object: 'list', data: models });
  });

  // GET /health
  api.get('/health', (_req, res) => {
    const monitor = router.getMonitor();
    const agreementIds = monitor.getAgreementIds();
    const violations = monitor.getViolations();

    const agreements: Record<string, unknown> = {};
    for (const id of agreementIds) {
      agreements[id] = monitor.getStats(id);
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      agreements: {
        active: agreementIds.length,
        with_violations: violations.length,
        details: agreements,
      },
    });
  });

  return api;
}
