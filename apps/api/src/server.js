import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { closePools } from './db.js';

const port = Number(process.env.PORT ?? 3000);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See apps/api/.env.example');
  process.exit(1);
}

const server = serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`rabbitry api on http://localhost:${info.port}`);
  console.log(`admin console  http://localhost:${info.port}/admin/login`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await closePools();
      process.exit(0);
    });
  });
}
