#!/usr/bin/env node
import chalk from 'chalk';
import {
  SellerAgent,
  BuyerAgent,
  EscrowManager,
  signMessage,
  generateKeyPair,
} from '@ophirai/sdk';
import type { RFQParams, QuoteParams, SLARequirement } from '@ophirai/protocol';
import { DEFAULT_CONFIG } from '@ophirai/protocol';
import { v4 as uuidv4 } from 'uuid';
import { computeComparison, formatComparison } from './comparison.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Print a step with consistent formatting. */
function step(label: string, color: typeof chalk.blue, msg: string): void {
  console.log(color(label) + ' ' + msg);
}

async function main() {
  let buyer: BuyerAgent | undefined;
  let seller: SellerAgent | undefined;

  async function cleanup() {
    await buyer?.close().catch(() => {});
    await seller?.close().catch(() => {});
  }

  process.on('SIGINT', async () => {
    console.log(chalk.dim('\nShutting down...'));
    await cleanup();
    process.exit(0);
  });

  try {
    // --- Banner ---
    console.log(chalk.bold.cyan('\n  Ophir — Agent Negotiation Protocol Demo'));
    console.log(chalk.dim('  Two AI agents negotiate a compute job in real-time.\n'));

    // --- Start seller agent on random port ---
    const sellerKeypair = generateKeyPair();
    const buyerKeypair = generateKeyPair();

    seller = new SellerAgent({
      keypair: sellerKeypair,
      endpoint: 'http://localhost:0',
      services: [
        {
          category: 'inference',
          description: 'GPU inference for vision models',
          base_price: '0.005',
          currency: 'USDC',
          unit: 'request',
        },
      ],
    });

    // Custom RFQ handler: quote at $0.005 with strong SLA
    seller.onRFQ(async (rfq: RFQParams): Promise<QuoteParams | null> => {
      const sla: SLARequirement = {
        metrics: [
          { name: 'p99_latency_ms', target: 300, comparison: 'lte' },
          { name: 'uptime_pct', target: 99.95, comparison: 'gte' },
          { name: 'accuracy_pct', target: 96, comparison: 'gte' },
        ],
        dispute_resolution: { method: 'lockstep_verification', timeout_hours: 24 },
      };

      const unsigned = {
        quote_id: uuidv4(),
        rfq_id: rfq.rfq_id,
        seller: {
          agent_id: seller!.getAgentId(),
          endpoint: seller!.getEndpoint(),
        },
        pricing: {
          price_per_unit: '0.005',
          currency: 'USDC',
          unit: 'request',
          pricing_model: 'fixed' as const,
          volume_discounts: [
            { min_units: 1000, price_per_unit: '0.004' },
            { min_units: 5000, price_per_unit: '0.0035' },
          ],
        },
        sla_offered: sla,
        expires_at: new Date(Date.now() + DEFAULT_CONFIG.quote_timeout_ms).toISOString(),
      };

      const signature = signMessage(unsigned, sellerKeypair.secretKey);
      return { ...unsigned, signature };
    });

    // Custom counter handler: accept at $0.004 with volume discount
    seller.onCounter(async (counter) => {
      const sla: SLARequirement = {
        metrics: [
          { name: 'p99_latency_ms', target: 300, comparison: 'lte' },
          { name: 'uptime_pct', target: 99.95, comparison: 'gte' },
          { name: 'accuracy_pct', target: 96, comparison: 'gte' },
        ],
        dispute_resolution: { method: 'lockstep_verification', timeout_hours: 24 },
      };

      const unsigned = {
        quote_id: uuidv4(),
        rfq_id: counter.rfq_id,
        seller: {
          agent_id: seller!.getAgentId(),
          endpoint: seller!.getEndpoint(),
        },
        pricing: {
          price_per_unit: '0.004',
          currency: 'USDC',
          unit: 'request',
          pricing_model: 'fixed' as const,
          volume_discounts: [
            { min_units: 5000, price_per_unit: '0.003' },
          ],
        },
        sla_offered: sla,
        expires_at: new Date(Date.now() + DEFAULT_CONFIG.quote_timeout_ms).toISOString(),
      };

      const signature = signMessage(unsigned, sellerKeypair.secretKey);
      return { ...unsigned, signature };
    });

    await seller.listen(0);
    const sellerPort = new URL(seller.getEndpoint()).port;
    step('[Seller]', chalk.blue, `GPU Inference Provider started on :${sellerPort}`);
    await delay(300);

    // --- Start buyer agent on random port ---
    buyer = new BuyerAgent({ keypair: buyerKeypair, endpoint: 'http://localhost:0' });
    await buyer.listen(0);
    const buyerPort = new URL(buyer.getEndpoint()).port;
    step('[Buyer]', chalk.blue, `Compute Buyer started on :${buyerPort}`);
    await delay(300);

    console.log(chalk.bold('\n  --- NEGOTIATION ---\n'));
    await delay(200);

    // --- Step 1: Send RFQ ---
    const session = await buyer.requestQuotes({
      sellers: [seller.getEndpoint()],
      service: {
        category: 'inference',
        requirements: { model: 'vision', min_accuracy: 0.95 },
      },
      budget: {
        max_price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
      },
      sla: {
        metrics: [
          { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
        ],
      },
    });
    step('[Buyer → Seller]', chalk.blue, 'RFQ: Need GPU inference, budget ' + chalk.yellow('$0.01/request') + ', p99 < 500ms');
    await delay(400);

    // --- Step 2: Wait for quote ---
    const quotes = await buyer.waitForQuotes(session, { minQuotes: 1, timeout: 10_000 });
    if (quotes.length === 0) {
      console.log(chalk.red('  No quotes received. Exiting.'));
      await cleanup();
      process.exit(1);
    }
    const firstQuote = quotes[0]!;
    step('[Seller → Buyer]', chalk.blue, 'Quote: ' + chalk.yellow('$0.005/request') + ', p99 < 300ms, uptime 99.95%');
    await delay(400);

    // --- Step 3: Buyer counters ---
    await buyer.counter(
      firstQuote,
      { price_per_unit: '0.003' },
      'Volume discount: 5000+ requests committed',
    );
    step('[Buyer → Seller]', chalk.blue, 'Counter: Offering ' + chalk.yellow('$0.003/request') + ' (volume: 5000+ requests)');
    await delay(400);

    // --- Step 4: Seller responds with $0.004 ---
    const updatedQuotes = await buyer.waitForQuotes(session, { minQuotes: 2, timeout: 10_000 });
    const acceptedQuote = updatedQuotes[updatedQuotes.length - 1]!;
    step('[Seller → Buyer]', chalk.blue, 'Accept: ' + chalk.yellow('$0.004/request') + ' with volume discount');
    await delay(400);

    // --- Step 5: Both sign agreement ---
    const agreement = await buyer.acceptQuote(acceptedQuote);
    step('[Agreement]', chalk.green, 'Hash: ' + chalk.dim(agreement.agreement_hash.slice(0, 16) + '...'));
    await delay(200);
    step('[Agreement]', chalk.green, chalk.green('Buyer signed ✓'));
    await delay(200);
    step('[Agreement]', chalk.green, chalk.green('Seller signed ✓'));
    await delay(300);

    // --- Step 6: Escrow PDA (derived, not funded in demo) ---
    const escrow = new EscrowManager();
    const hashHex = agreement.agreement_hash;
    const hashBytes = Uint8Array.from(hashHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const escrowResult = escrow.deriveEscrowAddress(buyerKeypair.publicKey, hashBytes) as
      unknown as { address: string; bump: number };
    const escrowAddr = typeof escrowResult === 'string' ? escrowResult : escrowResult.address;
    step('[Escrow]', chalk.green, 'PDA derived — deposit ' + chalk.yellow('3.00 USDC') + ' (simulated)');
    await delay(200);
    step('[Escrow]', chalk.green, 'Address: ' + chalk.dim(escrowAddr));

    // --- Result ---
    console.log(chalk.bold('\n  --- RESULT ---\n'));
    await delay(200);

    const comparison = computeComparison(0.01, 0.004, 'p99 < 300ms, 99.95% uptime');
    const lines = formatComparison(comparison).split('\n');
    for (const line of lines) {
      if (line.startsWith('WITHOUT')) {
        console.log(chalk.red.bold('  ' + line));
      } else if (line.startsWith('WITH')) {
        console.log(chalk.green.bold('  ' + line));
      } else if (line.includes('Savings')) {
        console.log(chalk.green.bold('  ' + line));
      } else if (line.trim() === '') {
        console.log();
      } else {
        console.log(chalk.white('    ' + line.trim()));
      }
    }

    // --- Integration examples ---
    console.log(chalk.bold('\n  --- INTEGRATION ---\n'));
    await delay(200);

    console.log(chalk.cyan.bold('  Buyer (15 lines):'));
    console.log(
      chalk.dim(`  import { BuyerAgent } from '@ophirai/sdk';

  const buyer = new BuyerAgent({ endpoint: 'http://localhost:3002' });
  await buyer.listen(3002);

  const session = await buyer.requestQuotes({
    sellers: ['http://seller.example.com'],
    service: { category: 'inference', requirements: { model: 'vision' } },
    budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
    sla: { metrics: [{ name: 'p99_latency_ms', target: 500, comparison: 'lte' }] },
  });

  const quotes = await buyer.waitForQuotes(session);
  const best = buyer.rankQuotes(quotes, 'cheapest')[0];
  const agreement = await buyer.acceptQuote(best);`),
    );

    console.log();

    console.log(chalk.cyan.bold('  Seller (15 lines):'));
    console.log(
      chalk.dim(`  import { SellerAgent } from '@ophirai/sdk';

  const seller = new SellerAgent({
    endpoint: 'http://localhost:3001',
    services: [{
      category: 'inference',
      description: 'GPU inference service',
      base_price: '0.005',
      currency: 'USDC',
      unit: 'request',
    }],
  });

  await seller.listen(3001);
  // Auto-responds to RFQs with quotes based on service config`),
    );

    console.log();

    // --- Cleanup ---
    await cleanup();
  } catch (err) {
    console.error(chalk.red('\n  Demo failed:'), err);
    await cleanup();
    process.exit(1);
  }
}

main();
