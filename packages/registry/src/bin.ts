#!/usr/bin/env node
import { createRegistryServer } from './index.js';

const port = parseInt(process.env.PORT ?? '8420', 10);
const dbPath = process.env.DB_PATH ?? './ophir-registry.db';

const { start } = createRegistryServer({ port, dbPath });
start().then(() => {
  console.log(`Ophir Registry listening on port ${port}`);
  console.log(`Database: ${dbPath}`);
});
