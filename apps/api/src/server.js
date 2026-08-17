import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { closePools } from './db.js';

const port = Number(process.env.PORT ?? 3000);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See apps/api/.env.example');
  process.exit(1);
}

const server = serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`rabbitfarmers api on http://localhost:${info.port}`);
  console.log(`admin console  http://localhost:${info.port}/admin/login`);
});

// Graceful shutdown, with a deadline.
//
// server.close() waits for open connections to drain, and keep-alive sockets do
// not drain on their own — so without the timeout the process hangs on SIGTERM
// and has to be SIGKILLed. That is a stuck container on every deploy, not just
// an annoyance in scripts.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 5000);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);   // second signal: stop asking nicely
    shuttingDown = true;

    const forced = setTimeout(() => {
      console.warn('shutdown timed out, exiting anyway');
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    forced.unref();

    server.close(async () => {
      clearTimeout(forced);
      await closePools();
      process.exit(0);
    });
  });
}
