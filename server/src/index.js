import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { basicAuth } from 'hono/basic-auth';
import { HTTPException } from 'hono/http-exception';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import config from './config.js';
import knex from './db/knex.js';
import { contextMiddleware } from './middleware/context.js';
import { HttpError } from './lib/util.js';
import { startWorker, requeueStale, stopWorker } from './lib/queue.js';

// Importing the services registers their queue handlers.
import './services/discovery.js';

import metaRoutes from './routes/meta.js';
import discoveryRoutes from './routes/discovery.js';
import leadsRoutes from './routes/leads.js';
import aiRoutes from './routes/ai.js';
import analyticsRoutes from './routes/analytics.js';
import settingsRoutes from './routes/settings.js';

const app = new Hono();

/**
 * The built frontend, when it is there.
 *
 * In the container the API and the UI are one origin - which is why the app
 * only ever fetches '/api/...' relative. Running `npm run dev` there is no
 * dist/ yet, so this whole branch stays off and Vite keeps proxying.
 */
const webDist =
  process.env.WEB_DIST ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const serveWeb = existsSync(path.join(webDist, 'index.html'));

app.use('*', logger());

/**
 * Opt-in front door, off unless APP_PASSWORD is set.
 *
 * Real auth here is a stub on purpose - an x-user-id header picks the acting
 * user (see middleware/context.js). That is fine behind a VPN and not fine on
 * a public URL, where the leads, the pipeline and the API keys behind it are
 * all one GET away. One shared login is not a permission model, it is a lock
 * on the door until the stub is replaced.
 */
if (process.env.APP_PASSWORD) {
  const gate = basicAuth({
    username: process.env.APP_USERNAME || 'dudeai',
    password: process.env.APP_PASSWORD,
  });
  // The container's healthcheck has no credentials to offer.
  app.use('*', (c, next) => (c.req.path === '/api/meta/health' ? next() : gate(c, next)));
}

app.use(
  '/api/*',
  cors({
    origin: config.corsOrigin.split(',').map((s) => s.trim()),
    allowHeaders: ['Content-Type', 'x-tenant-id', 'x-user-id'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);
app.use('/api/*', contextMiddleware);

const identity = (c) =>
  c.json({
    name: 'DudeAI Sales Agent',
    status: 'ok',
    api: '/api',
    health: '/api/meta/health',
  });

app.get('/api', identity);
if (!serveWeb) app.get('/', identity);

app.route('/api/meta', metaRoutes);
app.route('/api/discovery', discoveryRoutes);
app.route('/api/leads', leadsRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/analytics', analyticsRoutes);
app.route('/api/settings', settingsRoutes);

// Static files first, then index.html for anything else - the router owns the
// URL, so a hard refresh on /leads/abc has to come back as the app, not a 404.
// Registered after the API so nothing here can shadow a route.
if (serveWeb) {
  app.use('*', serveStatic({ root: webDist }));
  app.get('*', (c, next) =>
    c.req.path.startsWith('/api/')
      ? next()
      : serveStatic({ root: webDist, path: 'index.html' })(c, next)
  );
}

app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

/**
 * One error shape for the whole API. The frontend renders `error` directly, so
 * every message here is written to be read by a salesperson, not a developer.
 */
app.onError((err, c) => {
  // Hono throws these with the response already built - a 401 from basicAuth
  // carries the WWW-Authenticate header that makes the browser ask for it.
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof HttpError) {
    return c.json({ error: err.message, details: err.details || null }, err.status);
  }
  if (/violates foreign key|invalid input syntax/i.test(err.message)) {
    return c.json({ error: 'That reference does not exist any more. Refresh and try again.' }, 400);
  }
  console.error('[error]', err);
  return c.json(
    {
      error: 'Something broke on the server.',
      details: process.env.NODE_ENV === 'production' ? null : err.message,
    },
    500
  );
});

async function boot() {
  try {
    await knex.raw('select 1');
  } catch (e) {
    console.error('\nCannot reach Postgres: ' + e.message);
    console.error('Start it with:  docker compose up -d');
    console.error('Then:           npm run setup\n');
    process.exit(1);
  }

  const [{ count }] = await knex('tenants').count('* as count');
  if (Number(count) === 0) {
    console.warn('\nNo tenant seeded. Run:  npm run setup\n');
  }

  await requeueStale();
  startWorker({ concurrency: 1 });

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log('\n  DudeAI Sales Agent API');
    console.log('  http://localhost:' + info.port);
    console.log('  places: ' + (config.places.mock ? 'MOCK (no API key)' : 'live, ' + config.places.fieldTier + ' tier'));
    console.log('  gemini: ' + (config.gemini.mock ? 'MOCK (no API key)' : config.gemini.modelMain + ' / ' + config.gemini.modelFast));
    console.log('  pagespeed: ' + (config.pagespeed.enabled ? 'on' : 'off') + '\n');
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\nshutting down');
    stopWorker();
    await knex.destroy().catch(() => {});
    process.exit(0);
  });
}

boot();

export default app;
