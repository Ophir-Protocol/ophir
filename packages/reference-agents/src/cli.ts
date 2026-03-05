#!/usr/bin/env node

import { Command } from 'commander';
import { createInferenceAgent } from './agents/inference.js';
import { createDataProcessingAgent } from './agents/data-processing.js';
import { createCodeReviewAgent } from './agents/code-review.js';
import { createTranslationAgent } from './agents/translation.js';
import { createImageGenerationAgent } from './agents/image-generation.js';
import type { SellerAgent } from '@ophir/sdk';

const AGENT_TYPES = {
  'inference': { factory: createInferenceAgent, defaultPort: 3001 },
  'data-processing': { factory: createDataProcessingAgent, defaultPort: 3002 },
  'code-review': { factory: createCodeReviewAgent, defaultPort: 3003 },
  'translation': { factory: createTranslationAgent, defaultPort: 3004 },
  'image-generation': { factory: createImageGenerationAgent, defaultPort: 3005 },
} as const;

type AgentType = keyof typeof AGENT_TYPES;

const program = new Command();

program
  .name('ophir-agents')
  .description('Ophir reference seller agents')
  .version('0.1.0');

program
  .command('start <type>')
  .description('Start a specific agent')
  .option('-p, --port <port>', 'Port to listen on')
  .action(async (type: string, opts: { port?: string }) => {
    if (!(type in AGENT_TYPES)) {
      console.error(`Unknown agent type: ${type}`);
      console.error(`Available types: ${Object.keys(AGENT_TYPES).join(', ')}`);
      process.exit(1);
    }

    const agentType = type as AgentType;
    const entry = AGENT_TYPES[agentType];
    const port = opts.port ? parseInt(opts.port, 10) : entry.defaultPort;

    const agent = entry.factory({ port });
    await agent.listen(port);
    console.log(`[ophir-agents] ${type} agent started on port ${port}`);
    console.log(`[ophir-agents] Agent ID: ${agent.getAgentId()}`);
  });

program
  .command('start-all')
  .description('Start all 5 agents on consecutive ports')
  .option('-b, --base-port <port>', 'Base port (default: 3001)', '3001')
  .action(async (opts: { basePort: string }) => {
    const basePort = parseInt(opts.basePort, 10);
    const agents: SellerAgent[] = [];
    let i = 0;

    for (const [type, entry] of Object.entries(AGENT_TYPES)) {
      const port = basePort + i;
      const agent = entry.factory({ port });
      await agent.listen(port);
      agents.push(agent);
      console.log(`[ophir-agents] ${type} agent started on port ${port} — ${agent.getAgentId()}`);
      i++;
    }

    console.log(`\n[ophir-agents] All 5 agents running on ports ${basePort}-${basePort + 4}`);
  });

program
  .command('list')
  .description('List available agent types')
  .action(() => {
    console.log('Available agent types:\n');
    for (const [type, entry] of Object.entries(AGENT_TYPES)) {
      console.log(`  ${type.padEnd(20)} (default port: ${entry.defaultPort})`);
    }
  });

program.parse();
