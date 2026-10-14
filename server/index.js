import fs from 'node:fs';
import path from 'node:path';
import { createBifrostServer } from './server.js';

// Configuration (environment variables):
//   PORT            listening port (default 7780)
//   HOST            bind address (default 0.0.0.0)
//   DATA_DIR        where ids.json is kept (default ./data)
//   TRUST_PROXY=1   read the client IP from X-Forwarded-For (behind Caddy/nginx)
//   TLS_CERT/TLS_KEY  paths to serve HTTPS directly (otherwise put a TLS proxy in front)

const tls =
  process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }
    : null;

const app = createBifrostServer({
  port: Number(process.env.PORT ?? 7780),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  trustProxy: process.env.TRUST_PROXY === '1',
  tls,
  log: (m) => console.log(`${new Date().toISOString()} ${m}`),
});

const port = await app.listen();
console.log(`Bifrost server listening on ${tls ? 'https' : 'http'}://${process.env.HOST ?? '0.0.0.0'}:${port}`);
if (!tls) console.log('No TLS configured: put a TLS reverse proxy in front before exposing it to the Internet.');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
