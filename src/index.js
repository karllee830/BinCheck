import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from './app.js';
import { createStore } from './store.js';

const password = process.env.APP_PASSWORD;
const apiKey = process.env.RAPIDAPI_KEY;
const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.DATA_DIR ?? 'data';

const missing = [!password && 'APP_PASSWORD', !apiKey && 'RAPIDAPI_KEY'].filter(Boolean);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

let store;
try {
  mkdirSync(dataDir, { recursive: true });
  store = createStore(join(dataDir, 'bincheck.db'));
} catch (error) {
  console.error(`Cannot open the database in ${dataDir}: ${error.message}`);
  process.exit(1);
}

const server = createApp({
  password,
  apiKey,
  store,
  trustProxy: process.env.TRUST_PROXY === 'true',
});

server.listen(port, () => {
  console.log(`BIN Check listening on port ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
