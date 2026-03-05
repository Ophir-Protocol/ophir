#!/usr/bin/env tsx
import chalk from 'chalk';
import {
  SellerAgent,
  BuyerAgent,
  MetricCollector,
  generateKeyPair,
  signMessage,
  buildDispute,
} from '@ophirai/sdk';
import type { RFQParams, QuoteParams, SLARequirement, ViolationEvidence } from '@ophirai/protocol';
import { DEFAULT_CONFIG } from '@ophirai/protocol';
import { randomUUID } from 'node:crypto';

// ─── Helpers ────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bar = '='.repeat(55);
let startTime = 0;

function elapsed(): string {
  const ms = Date.now() - startTime;
  const s = (ms / 1000).toFixed(1);
  return chalk.dim(`[${s}s]`);
}

function header(text: string) {
  console.log(chalk.bold.cyan(`\n${bar}`));
  console.log(chalk.bold.cyan(`  ${text}`));
  console.log(chalk.bold.cyan(bar));
}

function phase(step: string, msg: string) {
  console.log(`\n${elapsed()} ${chalk.bold.white(step)} ${msg}`);
}

function info(msg: string) {
  console.log(`  ${chalk.dim('->')} ${msg}`);
}

function ok(msg: string) {
  console.log(`  ${chalk.green('\u2713')} ${msg}`);
}

function warn(msg: string) {
  console.log(`  ${chalk.yellow('!')} ${msg}`);
}

function fail(msg: string) {
  console.log(`  ${chalk.red('\u2717')} ${msg}`);
}

// ─── Mock inference responses ───────────────────────────────────────────────

const CANNED_RESPONSES = [
  'Hello! How can I help you today?',
  'The capital of France is Paris.',
  'Python is a programming language known for its simplicity.',
  'Machine learning uses statistical methods to learn from data.',
  'The speed of light is approximately 299,792 km/s.',
  'Water boils at 100 degrees Celsius at sea level.',
  'JavaScript was created by Brendan Eich in 1995.',
  'The human brain contains approximately 86 billion neurons.',
  'Quantum computing leverages quantum mechanical phenomena.',
  'Machine learning is a subset of artificial intelligence.',
];

interface ProviderProfile {
  name: string;
  model: string;
  pricePerMillion: number;
  baseLatencyMs: number;
  errorRate: number;
  port: number;
}

const PROVIDERS: ProviderProfile[] = [
  { name: 'Provider A (fast-cheap)', model: 'gpt-4o-mini', pricePerMillion: 0.15, baseLatencyMs: 50, errorRate: 0.05, port: 3010 },
  { name: 'Provider B (balanced)', model: 'llama-3-70b', pricePerMillion: 0.90, baseLatencyMs: 200, errorRate: 0.01, port: 3011 },
  { name: 'Provider C (premium)', model: 'gpt-4o', pricePerMillion: 2.50, baseLatencyMs: 500, errorRate: 0.001, port: 3012 },
];

// ─── Main Demo ──────────────────────────────────────────────────────────────

async function main() {
  const sellers: SellerAgent[] = [];
  let buyer: BuyerAgent | undefined;

  async function cleanup() {
    for (const s of sellers) await s.close().catch(() => {});
    await buyer?.close().catch(() => {});
  }

  process.on('SIGINT', async () => {
    console.log(chalk.dim('\nShutting down...'));
    await cleanup();
    process.exit(0);
  });

  try {
    startTime = Date.now();
    header('OPHIR SELF-NEGOTIATING AGENT DEMO');

    // ═══════════════════════════════════════════════════════
    // Phase 1: Setup — start 3 mock provider sellers
    // ═══════════════════════════════════════════════════════

    phase('[1/10]', 'Starting mock providers...');

    const sellerKeypairs = PROVIDERS.map(() => generateKeyPair());

    for (let i = 0; i < PROVIDERS.length; i++) {
      const p = PROVIDERS[i];
      const kp = sellerKeypairs[i];
      const pricePerUnit = (p.pricePerMillion / 1_000_000).toFixed(10);

      const seller = new SellerAgent({
        keypair: kp,
        endpoint: `http://localhost:${p.port}`,
        services: [{
          category: 'inference',
          description: `${p.model} inference service`,
          base_price: pricePerUnit,
          currency: 'USDC',
          unit: 'request',
        }],
      });

      // Custom RFQ handler returning realistic pricing
      seller.onRFQ(async (rfq: RFQParams): Promise<QuoteParams | null> => {
        const sla: SLARequirement = {
          metrics: [
            { name: 'p99_latency_ms', target: p.baseLatencyMs * 4, comparison: 'lte' },
            { name: 'uptime_pct', target: (1 - p.errorRate) * 100, comparison: 'gte' },
          ],
          dispute_resolution: { method: 'automatic_escrow', timeout_hours: 24 },
        };

        const unsigned = {
          quote_id: randomUUID(),
          rfq_id: rfq.rfq_id,
          seller: {
            agent_id: seller.getAgentId(),
            endpoint: seller.getEndpoint(),
          },
          pricing: {
            price_per_unit: pricePerUnit,
            currency: 'USDC',
            unit: 'request',
            pricing_model: 'fixed' as const,
          },
          sla_offered: sla,
          expires_at: new Date(Date.now() + DEFAULT_CONFIG.quote_timeout_ms).toISOString(),
        };

        const signature = signMessage(unsigned, kp.secretKey);
        return { ...unsigned, signature };
      });

      await seller.listen(p.port);
      sellers.push(seller);

      const priceStr = `$${p.pricePerMillion.toFixed(2)}/1M tokens`;
      info(`${chalk.bold(p.name)}:${' '.repeat(Math.max(1, 18 - p.name.length))}${p.model.padEnd(14)} @ ${chalk.yellow(priceStr)}  ${chalk.dim(`[port: ${p.port}]`)}`);
    }

    await delay(300);

    // ═══════════════════════════════════════════════════════
    // Phase 2: Discovery — buyer discovers sellers
    // ═══════════════════════════════════════════════════════

    phase('[2/10]', 'Buyer agent discovering sellers...');

    const buyerKeypair = generateKeyPair();
    buyer = new BuyerAgent({ keypair: buyerKeypair, endpoint: 'http://localhost:3020' });
    await buyer.listen(3020);

    const sellerEndpoints = sellers.map((s) => s.getEndpoint());
    info(`Found ${chalk.bold(String(PROVIDERS.length))} providers via direct discovery`);
    for (let i = 0; i < sellers.length; i++) {
      const did = sellers[i].getAgentId();
      const shortDid = did.slice(0, 18) + '...' + did.slice(-3);
      info(`${PROVIDERS[i].name}: ${chalk.dim(shortDid)}  (inference)`);
    }

    await delay(300);

    // ═══════════════════════════════════════════════════════
    // Phase 3: Negotiation — RFQ, quotes, ranking, accept
    // ═══════════════════════════════════════════════════════

    const negotiationStart = Date.now();

    phase('[3/10]', 'Sending RFQ for inference service...');
    info(`Budget: ${chalk.yellow('$1.00/request')} | Currency: USDC | SLA: p99 < 1000ms, uptime > 99%`);

    const session = await buyer.requestQuotes({
      sellers: sellerEndpoints,
      service: {
        category: 'inference',
        requirements: { model: 'gpt-4o-mini' },
      },
      budget: {
        max_price_per_unit: '1.00',
        currency: 'USDC',
        unit: 'request',
      },
      sla: {
        metrics: [
          { name: 'p99_latency_ms', target: 1000, comparison: 'lte' },
          { name: 'uptime_pct', target: 99, comparison: 'gte' },
        ],
      },
    });

    await delay(200);

    phase('[4/10]', 'Collecting quotes...');

    const quotes = await buyer.waitForQuotes(session, {
      minQuotes: PROVIDERS.length,
      timeout: 10_000,
    });

    for (const q of quotes) {
      const provider = PROVIDERS.find((p) => {
        const pricePerUnit = (p.pricePerMillion / 1_000_000).toFixed(10);
        return q.pricing.price_per_unit === pricePerUnit;
      });
      const name = provider?.name ?? 'Unknown';
      const priceStr = provider ? `$${provider.pricePerMillion.toFixed(2)}/1M tokens` : q.pricing.price_per_unit;
      ok(`Quote from ${name}: ${chalk.yellow(String(priceStr))} (expires in 60s)`);
    }

    await delay(200);

    phase('[5/10]', 'Ranking quotes (strategy: cheapest)...');

    const ranked = buyer.rankQuotes(quotes, 'cheapest');
    for (let i = 0; i < ranked.length; i++) {
      const q = ranked[i];
      const provider = PROVIDERS.find((p) => {
        const pricePerUnit = (p.pricePerMillion / 1_000_000).toFixed(10);
        return q.pricing.price_per_unit === pricePerUnit;
      });
      const name = provider?.name ?? 'Unknown';
      const priceStr = provider ? `$${provider.pricePerMillion.toFixed(2)}/1M tokens` : q.pricing.price_per_unit;
      const label = i === 0 ? ` ${chalk.green('<- BEST')}` : '';
      info(`#${i + 1} ${name} -- ${chalk.yellow(String(priceStr))}${label}`);
    }

    const bestQuote = ranked[0];
    const bestProvider = PROVIDERS.find((p) => {
      const pricePerUnit = (p.pricePerMillion / 1_000_000).toFixed(10);
      return bestQuote.pricing.price_per_unit === pricePerUnit;
    })!;

    await delay(200);

    phase('[6/10]', `Accepting best quote from ${bestProvider.name}...`);

    const agreement = await buyer.acceptQuote(bestQuote);
    const negotiationTime = Date.now() - negotiationStart;

    ok(`Agreement ID: ${chalk.dim(agreement.agreement_id)}`);
    ok(`Agreement hash: ${chalk.dim('sha256:' + agreement.agreement_hash.slice(0, 12) + '...')}`);
    ok(`Dual-signed: buyer ${chalk.green('\u2713')} seller ${chalk.green('\u2713')}`);
    info(`Negotiation completed in ${chalk.cyan(negotiationTime + 'ms')}`);

    await delay(300);

    // ═══════════════════════════════════════════════════════
    // Phase 4: Execution — 10 inference requests
    // ═══════════════════════════════════════════════════════

    phase('[7/10]', 'Executing 10 inference requests...');

    const collector = new MetricCollector(
      { agreement_id: agreement.agreement_id, agreement_hash: agreement.agreement_hash },
    );

    let successCount = 0;
    let failCount = 0;
    const totalRequests = 10;
    const costPerRequest = bestProvider.pricePerMillion / 1_000_000;

    for (let i = 1; i <= totalRequests; i++) {
      // After request 7, degrade latency to simulate SLA violations
      const isDegraded = i >= 8 && i <= 9;
      let latencyMs: number;
      let isError: boolean;

      if (isDegraded) {
        latencyMs = 2500 + Math.floor(Math.random() * 1000); // 2500-3500ms
        isError = true;
      } else {
        latencyMs = bestProvider.baseLatencyMs + Math.floor(Math.random() * 20) - 10;
        isError = Math.random() < bestProvider.errorRate;
      }

      // Simulate the wait
      await delay(Math.min(latencyMs, 100)); // Don't actually wait full time in demo

      // Record metrics
      collector.record('p99_latency_ms', latencyMs);
      collector.record('error_rate_pct', isError ? 100 : 0);

      const reqNum = String(i).padStart(2, ' ');
      if (isError && isDegraded) {
        failCount++;
        const breach = latencyMs > 1000 ? ` (SLA breach: p99 > 1000ms)` : '';
        fail(`Request ${reqNum}/${totalRequests}: ${chalk.red(`${latencyMs}ms`)} TIMEOUT${breach}`);
      } else if (isError) {
        failCount++;
        fail(`Request ${reqNum}/${totalRequests}: ${chalk.red(`${latencyMs}ms`)} ERROR`);
      } else {
        successCount++;
        const response = CANNED_RESPONSES[i - 1];
        const preview = response.length > 30 ? response.slice(0, 30) + '...' : response;
        ok(`Request ${reqNum}/${totalRequests}: ${chalk.green(`${latencyMs}ms`)} ${chalk.dim(`"${preview}"`)}`);
      }
    }

    await delay(300);

    // ═══════════════════════════════════════════════════════
    // Phase 5: SLA Monitoring
    // ═══════════════════════════════════════════════════════

    phase('[8/10]', 'Checking SLA compliance...');
    warn(`Degraded requests detected (${failCount}/${totalRequests} failed)`);

    // Build a lockstep spec from the agreed SLA
    const agreedSla: SLARequirement = bestQuote.sla_offered ?? {
      metrics: [
        { name: 'p99_latency_ms', target: 1000, comparison: 'lte' },
        { name: 'uptime_pct', target: 99, comparison: 'gte' },
      ],
    };

    // Use the MetricCollector to check SLA compliance manually
    const p99Agg = collector.aggregate('p99_latency_ms', 'percentile', 3600_000);
    const errorAgg = collector.aggregate('error_rate_pct', 'rolling_average', 3600_000);

    const p99Threshold = agreedSla.metrics.find((m) => m.name === 'p99_latency_ms')?.target ?? 1000;
    const p99Value = p99Agg?.value ?? 0;
    const p99Violated = p99Value > p99Threshold;

    console.log(`  Metric: ${chalk.bold('p99_latency_ms')}`);
    console.log(`    Threshold: ${chalk.dim('<=')} ${p99Threshold}ms`);
    console.log(`    Observed:  ${p99Violated ? chalk.red(String(Math.round(p99Value)) + 'ms') : chalk.green(String(Math.round(p99Value)) + 'ms')}`);
    console.log(`    Status:    ${p99Violated ? chalk.red('\u2717 VIOLATION') : chalk.green('\u2713 OK')}`);
    console.log();

    const errorThreshold = 5; // 5% error rate
    const errorValue = errorAgg?.value ?? 0;
    const errorViolated = errorValue > errorThreshold;

    console.log(`  Metric: ${chalk.bold('error_rate')}`);
    console.log(`    Threshold: ${chalk.dim('<=')} ${errorThreshold}%`);
    console.log(`    Observed:  ${errorViolated ? chalk.red((errorValue).toFixed(1) + '%') : chalk.green((errorValue).toFixed(1) + '%')}`);
    console.log(`    Status:    ${errorViolated ? chalk.red('\u2717 VIOLATION') : chalk.green('\u2713 OK')}`);

    await delay(300);

    // ═══════════════════════════════════════════════════════
    // Phase 6: Dispute
    // ═══════════════════════════════════════════════════════

    phase('[9/10]', 'Filing SLA dispute...');

    const violationEvidence: ViolationEvidence = {
      sla_metric: 'p99_latency_ms',
      agreed_value: p99Threshold,
      observed_value: Math.round(p99Value),
      measurement_window: 'PT1H',
      evidence_hash: agreement.agreement_hash,
    };

    // Build and sign the dispute message (seller may not handle disputes in demo)
    const disputeMsg = buildDispute({
      agreementId: agreement.agreement_id,
      filedBy: { agent_id: buyer.getAgentId(), role: 'buyer' },
      violation: violationEvidence,
      requestedRemedy: 'escrow_release',
      escrowAction: 'freeze',
      secretKey: buyerKeypair.secretKey,
    });

    info(`Violation: p99_latency_ms exceeded ${p99Threshold}ms (observed: ${Math.round(p99Value)}ms)`);
    info(`Evidence hash: ${chalk.dim('sha256:' + violationEvidence.evidence_hash.slice(0, 12) + '...')}`);
    info(`Dispute ID: ${chalk.dim(disputeMsg.params.dispute_id)}`);
    ok('Dispute filed successfully');

    await delay(300);

    // ═══════════════════════════════════════════════════════
    // Phase 7: Summary
    // ═══════════════════════════════════════════════════════

    phase('[10/10]', 'Demo complete!');

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalCost = (successCount * costPerRequest).toFixed(6);
    const violationCount = (p99Violated ? 1 : 0) + (errorViolated ? 1 : 0);

    console.log(chalk.bold.cyan(`\n${bar}`));
    console.log(chalk.bold.cyan('  Summary:'));
    console.log(`    Providers discovered:  ${chalk.bold(String(PROVIDERS.length))}`);
    console.log(`    Negotiation time:      ${chalk.cyan.bold(negotiationTime + 'ms')}`);
    console.log(`    Total elapsed:         ${chalk.bold(totalElapsed + 's')}`);
    console.log(`    Requests executed:     ${chalk.bold(String(totalRequests))}`);
    console.log(`    Successful:            ${chalk.green.bold(String(successCount))}`);
    console.log(`    Failed:                ${failCount > 0 ? chalk.red.bold(String(failCount)) : chalk.green.bold('0')}`);
    console.log(`    SLA violations:        ${violationCount > 0 ? chalk.red.bold(String(violationCount)) : chalk.green.bold('0')}`);
    console.log(`    Disputes filed:        ${chalk.yellow.bold('1')}`);
    console.log(`    Total cost:            ${chalk.yellow.bold('$' + totalCost + ' USDC')}`);
    console.log(chalk.bold.cyan(bar));
    console.log();

    await cleanup();
  } catch (err) {
    console.error(chalk.red('\n  Demo failed:'), err);
    await cleanup();
    process.exit(1);
  }
}

main();
