#!/usr/bin/env node
import { OphirMCPServer } from './index.js';

const server = new OphirMCPServer();
server.startStdio().catch((err) => {
  process.stderr.write(`Ophir MCP Server error: ${err.message}\n`);
  process.exit(1);
});
