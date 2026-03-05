#!/usr/bin/env node
import { VERSION } from './version.js';
import { OphirMCPServer } from './index.js';

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

const server = new OphirMCPServer();
server.startStdio().catch((err) => {
  process.stderr.write(`Ophir MCP Server error: ${err.message}\n`);
  process.exit(1);
});
