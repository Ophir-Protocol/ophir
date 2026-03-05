#!/usr/bin/env node
import { OphirMCPServer } from '../index.js';

const server = new OphirMCPServer();
server.startStdio().catch((err) => {
  process.stderr.write(`[ophir-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
