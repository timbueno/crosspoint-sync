import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { enqueue } from '../src/connectors/queue.js';
import { drainQueue } from '../src/connectors/runner.js';
import { saveMatch } from '../src/connectors/store.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { DOC, makeTestApp, registerUser, type TestServer } from './helpers.js';
import { makeMicroblogTransport } from './microblog-helpers.js';

const META = { document: DOC, title: 'Foundryside', author: 'Robert Jackson Bennett' };

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64);
  resetEncryptionKeyCache();
});
afterEach(() => {
  delete process.env.TOKEN_ENC_KEY;
  resetEncryptionKeyCache();
});

async function setup(
  fake: ReturnType<typeof makeMicroblogTransport>,
  metadata: { document: string; title: string; author: string | null } = META
) {
  const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
  const { headers, username } = await registerUser(app);
  expect((await app.request('/api/v1/connectors/microblog', {
    method: 'PUT', headers,
    body: JSON.stringify({ credential: { token: 'mb-token' } }),
  })).status).toBe(200);
  await app.request('/api/v1/documents', {
    method: 'PUT', headers, body: JSON.stringify({ items: [metadata] }),
  });
  const userId = (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
  fake.clearCalls();
  return { app, db, headers, userId };
}

async function sync(
  app: TestServer['app'],
  headers: Record<string, string>,
  percentage: number,
  deviceId = 'd1'
) {
  await app.request('/syncs/progress', {
    method: 'PUT', headers,
    body: JSON.stringify({ document: DOC, progress: 'p', percentage, device_id: deviceId }),
  });
}

function queueStatus(db: TestServer['db']) {
  return db.prepare(
    `SELECT status FROM connector_queue WHERE connector_id = 'microblog' ORDER BY id DESC LIMIT 1`
  ).get() as { status: string };
}

it('links Micro.blog and creates an unmatched progress book on Currently reading', async () => {
  const fake = makeMicroblogTransport({ createResponse: { id: 90 } });
  const { app, db, headers } = await setup(fake);
  await sync(app, headers, 0.3);
  await drainQueue(db, fake.transport, 10);
  expect(fake.calls.some((call) => call.url.endsWith('/books') && call.method === 'POST')).toBe(true);
  expect(fake.shelves.get('reading')?.some((book) => book.id === '90')).toBe(true);
  expect(db.prepare(
    `SELECT external_id FROM connector_matches WHERE connector_id = 'microblog' AND document = ?`
  ).get(DOC)).toEqual({ external_id: '90' });
  expect(queueStatus(db)).toEqual({ status: 'done' });
});

it('returns Micro.blog search options through the Matches endpoint', async () => {
  const fake = makeMicroblogTransport({
    searchItems: [{
      id: 37779109,
      title: 'Foundryside',
      authors: [{ name: 'Robert Jackson Bennett' }],
      _microblog: { isbn: '9781786487849' },
    }],
  });
  const { app, headers } = await setup(fake);

  const response = await app.request(
    '/api/v1/connectors/microblog/search?q=Foundryside%20book',
    { headers }
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    books: [{
      externalId: '37779109',
      title: 'Foundryside',
      author: 'Robert Jackson Bennett',
      edition: '9781786487849',
    }],
  });
  const request = fake.calls.find((call) => new URL(call.url).pathname === '/books/search');
  expect(new URL(request!.url).searchParams.get('q')).toBe('Foundryside book');
});

it('acknowledges zero progress without any Micro.blog request', async () => {
  const fake = makeMicroblogTransport();
  const { app, db, headers } = await setup(fake);
  await sync(app, headers, 0);
  await drainQueue(db, fake.transport, 10);
  expect(fake.calls).toHaveLength(0);
  expect(queueStatus(db)).toEqual({ status: 'done' });
});

it('reuses a Want to read id instead of creating a new book', async () => {
  const book = { id: '77', title: META.title, author: META.author! };
  const fake = makeMicroblogTransport({ shelves: { 'to-read': [book] } });
  const { app, db, headers } = await setup(fake);
  await sync(app, headers, 0.4);
  await drainQueue(db, fake.transport, 10);
  expect(fake.calls.some((call) => call.url.endsWith('/books') && call.method === 'POST')).toBe(false);
  expect(fake.shelves.get('reading')?.some((book) => book.id === '77')).toBe(true);
  expect(fake.shelves.get('to-read')?.some((book) => book.id === '77')).toBe(false);
  expect(queueStatus(db)).toEqual({ status: 'done' });
});

it('creates a finished event directly on Finished reading', async () => {
  const fake = makeMicroblogTransport({ createResponse: { id: 91 } });
  const { app, db, headers } = await setup(fake);
  await sync(app, headers, 0.99);
  await drainQueue(db, fake.transport, 10);
  expect(fake.shelves.get('finished')?.some((book) => book.title === 'Foundryside')).toBe(true);
  expect(queueStatus(db)).toEqual({ status: 'done' });
});

it('does not let an older progress retry regress a newer finished state', async () => {
  const book = { id: '92', title: META.title, author: META.author! };
  const fake = makeMicroblogTransport({ shelves: { reading: [book] } });
  const { app, db, headers, userId } = await setup(fake);
  saveMatch(db, userId, 'microblog', DOC, { externalId: book.id, confidence: 1 }, 'auto');

  let failShelfLookup = true;
  const failOnce: HttpTransport = async (url, init) => {
    if (failShelfLookup && init.method === 'GET' && new URL(url).pathname === '/books/bookshelves') {
      failShelfLookup = false;
      return {
        status: 500,
        text: async () => JSON.stringify({ error: 'temporary' }),
        json: async () => ({ error: 'temporary' }),
      };
    }
    return fake.transport(url, init);
  };

  await sync(app, headers, 0.4);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await drainQueue(db, failOnce, 10);
  } finally {
    errorLog.mockRestore();
  }
  const retry = db.prepare(
    `SELECT status, attempts, next_try_at FROM connector_queue
     WHERE connector_id = 'microblog' AND document = ? AND kind = 'progress'`
  ).get(DOC) as { status: string; attempts: number; next_try_at: number };
  expect(retry).toMatchObject({ status: 'pending', attempts: 1 });

  await sync(app, headers, 0.99);
  expect(await drainQueue(db, fake.transport, 10)).toBe(1);
  expect(fake.shelves.get('finished')).toContainEqual(book);
  expect(fake.shelves.get('reading')).not.toContainEqual(book);

  fake.clearCalls();
  expect(await drainQueue(db, fake.transport, 10, retry.next_try_at)).toBe(1);
  expect(fake.calls).toHaveLength(0);
  expect(fake.shelves.get('finished')).toContainEqual(book);
  expect(fake.shelves.get('reading')).not.toContainEqual(book);
  expect(queueStatus(db)).toEqual({ status: 'done' });
});

it('uses canonical device ordering when two progress rows have the same timestamp', async () => {
  const book = { id: '93', title: META.title, author: META.author! };
  const fake = makeMicroblogTransport({ shelves: { reading: [book] } });
  const { app, db, headers, userId } = await setup(fake);
  saveMatch(db, userId, 'microblog', DOC, { externalId: book.id, confidence: 1 }, 'auto');

  await sync(app, headers, 0.4, 'z-stale-reader');
  await sync(app, headers, 0.99, 'a-canonical-reader');
  db.prepare(
    'UPDATE progress SET updated_at = 100 WHERE user_id = ? AND document = ?'
  ).run(userId, DOC);
  db.prepare(
    `UPDATE connector_queue
     SET next_try_at = CASE kind WHEN 'finished' THEN 100 ELSE 101 END
     WHERE user_id = ? AND connector_id = 'microblog' AND document = ?`
  ).run(userId, DOC);

  const canonical = await (await app.request(`/syncs/progress/${DOC}`, { headers })).json();
  expect(canonical).toMatchObject({
    device_id: 'a-canonical-reader',
    percentage: 0.99,
    timestamp: 100,
  });

  fake.clearCalls();
  expect(await drainQueue(db, fake.transport, 10, 100)).toBe(1);
  expect(fake.shelves.get('finished')).toContainEqual(book);
  expect(fake.shelves.get('reading')).not.toContainEqual(book);

  fake.clearCalls();
  expect(await drainQueue(db, fake.transport, 10, 101)).toBe(1);
  expect(fake.calls).toHaveLength(0);
  expect(fake.shelves.get('finished')).toContainEqual(book);
  expect(fake.shelves.get('reading')).not.toContainEqual(book);
  expect(db.prepare(
    `SELECT kind, status FROM connector_queue
     WHERE user_id = ? AND connector_id = 'microblog' AND document = ?
     ORDER BY kind`
  ).all(userId, DOC)).toEqual([
    { kind: 'finished', status: 'done' },
    { kind: 'progress', status: 'done' },
  ]);
});

it('does not create when author metadata is missing', async () => {
  const fake = makeMicroblogTransport();
  const { app, db, headers } = await setup(fake, { ...META, author: null });
  await sync(app, headers, 0.4);
  await drainQueue(db, fake.transport, 10);
  expect(fake.calls.some((call) => call.url.endsWith('/books') && call.method === 'POST')).toBe(false);
  expect(queueStatus(db)).toEqual({ status: 'dead' });
});

it('keeps a manual no-match override authoritative', async () => {
  const fake = makeMicroblogTransport();
  const { db, userId } = await setup(fake);
  saveMatch(db, userId, 'microblog', DOC, null, 'manual');
  enqueue(db, userId, 'microblog', {
    kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1,
  });
  await drainQueue(db, fake.transport, 10);
  expect(fake.calls.some((call) => call.url.endsWith('/books') && call.method === 'POST')).toBe(false);
  expect(queueStatus(db)).toEqual({ status: 'dead' });
});

it('marks the account needs_reauth when shelf lookup returns 401', async () => {
  const fake = makeMicroblogTransport();
  const { app, db, headers } = await setup(fake);
  fake.fail('GET', '/books/bookshelves', 401);
  await sync(app, headers, 0.4);
  await drainQueue(db, fake.transport, 10);
  expect(db.prepare(
    `SELECT status FROM connector_accounts WHERE connector_id = 'microblog'`
  ).get()).toEqual({ status: 'needs_reauth' });
  expect(queueStatus(db)).toEqual({ status: 'dead' });
});
