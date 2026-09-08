# Micro.blog Bookshelves Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a token-authenticated Micro.blog connector that reconciles CrossPoint Sync reading state into Micro.blog's Currently reading and Finished reading shelves without duplicating books already present in Want to read, Loans, or Holds.

**Architecture:** Extend the connector contract with optional event filtering, event-aware matching, and event-aware creation. Keep Micro.blog API and bookshelf reconciliation logic in one connector module, use the existing durable queue and encrypted credential store, and preserve manual match overrides. A stateful fake Micro.blog transport will verify HTTP behavior without live API calls.

**Tech Stack:** TypeScript 5.7, Node.js 22, Hono, SQLite, Vitest 3, built-in `fetch` through `HttpTransport`

**Spec:** `docs/superpowers/specs/2026-09-04-microblog-bookshelves-connector-design.md`

## Global Constraints

- Version 1 uses a manually pasted Micro.blog app token; OAuth and IndieAuth are out of scope.
- Progress `<= 0` is a no-op, progress `> 0` and `< 0.98` maps to `reading`, and `finished` or percentage `>= 0.98` maps to `finished`.
- Automatic matching and creation require both a non-empty title and a non-empty author.
- Search `reading`, `finished`, `to-read`, `loans`, and `holds` before creating a book.
- Candidate precedence is destination, opposite reading state, `to-read`, `loans`, then `holds`.
- Remove only `to-read` and the opposite reading-state membership; never remove `loans` or `holds`.
- Assign the destination before removing any source membership.
- Use only the fixed HTTPS origin `https://micro.blog`; never log credentials.
- No database migration, live Micro.blog call during automated tests, new runtime dependency, or third-party catalog-search service.

---

### Task 1: Add event-aware connector lifecycle primitives

**Files:**
- Create: `test/connector-lifecycle.test.ts`
- Modify: `src/connectors/types.ts:92-180`

**Interfaces:**
- Produces: `ConnectorOperationError(message: string, retryable: boolean, needsReauth?: boolean)`
- Produces: `Connector.shouldPush?(ev: OutboundEvent): boolean`
- Changes: `Connector.match(cred, doc, http, ev?)`
- Produces: `Connector.createBook?(cred, doc, ev, http): Promise<Match | null>`

- [ ] **Step 1: Write the failing lifecycle primitive tests**

Create `test/connector-lifecycle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ConnectorOperationError,
  type Connector,
  type OutboundEvent,
} from '../src/connectors/types.js';

describe('connector lifecycle primitives', () => {
  it('carries retry and reauthentication policy on operational errors', () => {
    const error = new ConnectorOperationError('microblog shelves: HTTP 401', false, true);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'microblog shelves: HTTP 401',
      retryable: false,
      needsReauth: true,
    });
  });

  it('accepts event-aware optional hooks without changing existing connectors', () => {
    const event: OutboundEvent = {
      kind: 'progress', document: 'd', percentage: 0, timestamp: 1,
    };
    const connector = {
      shouldPush: (ev: OutboundEvent) => (ev.percentage ?? 0) > 0,
      createBook: async () => ({ externalId: '9', confidence: 1 }),
    } satisfies Pick<Connector, 'shouldPush' | 'createBook'>;

    expect(connector.shouldPush(event)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `npm test -- test/connector-lifecycle.test.ts`

Expected: FAIL because `ConnectorOperationError`, `shouldPush`, and `createBook` do not exist.

- [ ] **Step 3: Add the lifecycle primitives**

Add after `PushResult` in `src/connectors/types.ts`:

```ts
export class ConnectorOperationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly needsReauth = false
  ) {
    super(message);
    this.name = 'ConnectorOperationError';
  }
}
```

Change the `Connector` methods to:

```ts
/** Return false to acknowledge an event without matching or pushing it. */
shouldPush?(ev: OutboundEvent): boolean;

/** Resolve a document to an external book id. Null = no confident match. */
match(
  cred: Credential,
  doc: DocumentMeta,
  http: HttpTransport,
  ev?: OutboundEvent
): Promise<Match | null>;

/** Create an external book only after matching found no existing record. */
createBook?(
  cred: Credential,
  doc: DocumentMeta,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<Match | null>;
```

Existing connector functions intentionally keep their three-argument implementations; TypeScript permits them to satisfy a callable interface with one optional trailing argument.

- [ ] **Step 4: Run focused tests and the build**

Run: `npm test -- test/connector-lifecycle.test.ts && npm run build`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/types.ts test/connector-lifecycle.test.ts
git commit -m "feat: add event-aware connector lifecycle hooks"
```

---

### Task 2: Implement Micro.blog authentication, shelf inventory, matching, and creation

**Files:**
- Create: `src/connectors/microblog.ts`
- Create: `test/microblog-helpers.ts`
- Create: `test/microblog.test.ts`

**Interfaces:**
- Consumes: `ConnectorOperationError`, `Credential`, `DocumentMeta`, `HttpTransport`, `Match`, `OutboundEvent`
- Produces: `_microblog.validateCredential(cred, http): Promise<ValidateResult>`
- Produces: `_microblog.matchBook(cred, doc, http, ev?): Promise<Match | null>`
- Produces: `_microblog.createBook(cred, doc, ev, http): Promise<Match | null>`
- Produces: `makeMicroblogTransport(initial)` test utility with `transport`, `calls`, `shelves`, `fail`, and `clearCalls`

- [ ] **Step 1: Create the stateful fake transport**

In `test/microblog-helpers.ts`, define these public shapes and implement the fixed Micro.blog routes:

```ts
import type { HttpTransport } from '../src/connectors/types.js';

export interface FakeMicroblogBook {
  id: string;
  title: string;
  author: string;
}

export type FakeShelfType = 'reading' | 'finished' | 'to-read' | 'loans' | 'holds';

export interface FakeMicroblogOptions {
  shelves?: Partial<Record<FakeShelfType, FakeMicroblogBook[]>>;
  createResponse?: unknown;
  omitShelves?: FakeShelfType[];
}

export function makeMicroblogTransport(options: FakeMicroblogOptions = {}) {
  const calls: Array<{
    url: string; method: string; headers?: Record<string, string>; body?: string;
  }> = [];
  const failures = new Map<string, { status: number; body: unknown }>();
  const ids: Record<FakeShelfType, string> = {
    reading: '10', finished: '11', 'to-read': '12', loans: '13', holds: '14',
  };
  const shelves = new Map<FakeShelfType, FakeMicroblogBook[]>(
    (Object.keys(ids) as FakeShelfType[]).map((type) => [
      type, [...(options.shelves?.[type] ?? [])],
    ])
  );
  let mutateCreate = true;
  let nextId = 1000;
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const parsed = new URL(url);
    const forced = failures.get(`${init.method} ${parsed.pathname}`);
    if (forced) return response(forced.status, forced.body);
    if (init.method === 'GET' && parsed.pathname === '/books/bookshelves') {
      return response(200, {
        items: (Object.keys(ids) as FakeShelfType[])
          .filter((type) => !options.omitShelves?.includes(type))
          .map((type) => ({ id: Number(ids[type]), title: type, _microblog: { type } })),
      });
    }
    const shelfMatch = parsed.pathname.match(/^\/books\/bookshelves\/(\d+)$/);
    if (init.method === 'GET' && shelfMatch) {
      const type = (Object.keys(ids) as FakeShelfType[]).find((key) => ids[key] === shelfMatch[1]);
      if (!type) return response(404, {});
      return response(200, {
        items: shelves.get(type)!.map((book) => ({
          id: Number(book.id), title: book.title,
          authors: [{ name: book.author }], _microblog: { isbn: '' },
        })),
      });
    }
    if (init.method === 'POST' && parsed.pathname === '/books') {
      const form = new URLSearchParams(init.body);
      const type = (Object.keys(ids) as FakeShelfType[]).find((key) => ids[key] === form.get('bookshelf_id'));
      if (!type) return response(422, {});
      const configured = options.createResponse ?? {};
      const rawId = (configured as any)?.id ?? (configured as any)?.book_id
        ?? (configured as any)?.item?.id ?? (configured as any)?.book?.id;
      const id = rawId == null ? String(nextId++) : String(rawId);
      if (mutateCreate) {
        shelves.get(type)!.push({ id, title: form.get('title')!, author: form.get('author')! });
      }
      return response(200, configured);
    }
    const assignMatch = parsed.pathname.match(/^\/books\/bookshelves\/(\d+)\/assign$/);
    if (init.method === 'POST' && assignMatch) {
      const target = (Object.keys(ids) as FakeShelfType[]).find((key) => ids[key] === assignMatch[1]);
      const bookId = new URLSearchParams(init.body).get('book_id');
      const book = [...shelves.values()].flat().find((item) => item.id === bookId);
      if (!target || !book) return response(422, {});
      if (!shelves.get(target)!.some((item) => item.id === book.id)) shelves.get(target)!.push(book);
      return response(200, {});
    }
    const removeMatch = parsed.pathname.match(/^\/books\/bookshelves\/(\d+)\/remove\/([^/]+)$/);
    if (init.method === 'DELETE' && removeMatch) {
      const target = (Object.keys(ids) as FakeShelfType[]).find((key) => ids[key] === removeMatch[1]);
      if (!target) return response(404, {});
      shelves.set(target, shelves.get(target)!.filter((item) => item.id !== decodeURIComponent(removeMatch[2])));
      return response(200, {});
    }
    throw new Error(`unexpected Micro.blog request: ${init.method} ${parsed.pathname}`);
  };

  return {
    transport,
    calls,
    shelves,
    fail(method: string, path: string, status: number, body: unknown = {}) {
      failures.set(`${method} ${path}`, { status, body });
    },
    disableCreateMutation() { mutateCreate = false; },
    clearCalls() { calls.length = 0; },
  };
}

function response(status: number, body: unknown) {
  return {
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    json: async () => body,
  };
}
```

Use JSON Feed item shapes identical to the Micro.blog documentation:

```ts
{
  id: Number(book.id),
  title: book.title,
  authors: [{ name: book.author }],
  _microblog: { isbn: '' },
}
```

- [ ] **Step 2: Write failing tests for validation and matching**

Create `test/microblog.test.ts` with the shared fixtures and these tests:

```ts
import { describe, expect, it } from 'vitest';
import { ConnectorOperationError } from '../src/connectors/types.js';
import { _microblog } from '../src/connectors/microblog.js';
import { makeMicroblogTransport } from './microblog-helpers.js';

const CRED = { token: 'mb-token' };
const DOC = {
  document: 'd', title: 'The Left Hand of Darkness',
  author: 'Ursula K. Le Guin', filename: null,
};
const EV = { kind: 'progress' as const, document: 'd', percentage: 0.4, timestamp: 1 };

describe('Micro.blog shelf lookup', () => {
  it('validates an app token against the bookshelves endpoint', async () => {
    const fake = makeMicroblogTransport();
    expect(await _microblog.validateCredential(CRED, fake.transport)).toEqual({ ok: true });
    expect(fake.calls[0]).toMatchObject({
      url: 'https://micro.blog/books/bookshelves', method: 'GET',
      headers: { authorization: 'Bearer mb-token' },
    });
  });

  it('rejects a missing token and an unauthorized token', async () => {
    const fake = makeMicroblogTransport();
    expect((await _microblog.validateCredential({}, fake.transport)).ok).toBe(false);
    fake.fail('GET', '/books/bookshelves', 401);
    expect(await _microblog.validateCredential(CRED, fake.transport)).toEqual({
      ok: false, error: 'invalid token',
    });
  });

  it('prefers destination, opposite, want, loans, then holds', async () => {
    const wanted = { id: '30', title: DOC.title!, author: DOC.author! };
    const loan = { ...wanted, id: '31' };
    const fake = makeMicroblogTransport({ shelves: { 'to-read': [wanted], loans: [loan] } });
    expect((await _microblog.matchBook(CRED, DOC, fake.transport, EV))?.externalId).toBe('30');
  });

  it('treats absent optional Libby shelves as empty', async () => {
    const wanted = { id: '32', title: DOC.title!, author: DOC.author! };
    const fake = makeMicroblogTransport({
      shelves: { 'to-read': [wanted] }, omitShelves: ['loans', 'holds'],
    });
    expect((await _microblog.matchBook(CRED, DOC, fake.transport, EV))?.externalId).toBe('32');
  });

  it('matches normalized title and author and collapses repeated ids', async () => {
    const book = { id: '40', title: 'The Left Hand of Darkness: A Novel', author: 'Le Guin, Ursula K.' };
    const fake = makeMicroblogTransport({ shelves: { loans: [book], holds: [book] } });
    const match = await _microblog.matchBook(CRED, DOC, fake.transport, EV);
    expect(match?.externalId).toBe('40');
  });

  it('joins multiple API author names for matching', () => {
    expect(_microblog.extractBooks({
      items: [{ id: 5, title: 'Good Omens', authors: [{ name: 'Neil Gaiman' }, { name: 'Terry Pratchett' }] }],
    }, 'reading')).toEqual([{
      externalId: '5', title: 'Good Omens', author: 'Neil Gaiman, Terry Pratchett',
      memberships: new Set(['reading']),
    }]);
  });

  it.each([
    [{ ...DOC, title: null }],
    [{ ...DOC, author: null }],
    [{ ...DOC, author: '   ' }],
  ])('does not auto-match incomplete metadata', async (doc) => {
    const fake = makeMicroblogTransport({ shelves: { reading: [{ id: '1', title: DOC.title!, author: DOC.author! }] } });
    expect(await _microblog.matchBook(CRED, doc, fake.transport, EV)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run matching tests and verify the expected failure**

Run: `npm test -- test/microblog.test.ts`

Expected: FAIL because `src/connectors/microblog.ts` does not exist.

- [ ] **Step 4: Implement token handling, JSON Feed parsing, and event-aware matching**

In `src/connectors/microblog.ts`, add:

```ts
const BASE_URL = 'https://micro.blog';
const RELEVANT = ['reading', 'finished', 'to-read', 'loans', 'holds'] as const;
type ShelfType = (typeof RELEVANT)[number];

interface ShelfDefinition { id: string; type: ShelfType; }
interface ShelfBook {
  externalId: string;
  title: string;
  author: string;
  memberships: Set<ShelfType>;
}

function tokenOf(cred: Credential): string {
  const token = cred.token;
  if (typeof token !== 'string' || !token.trim()) {
    throw new ConnectorOperationError('missing Micro.blog token', false);
  }
  return token.trim();
}

function destination(ev?: OutboundEvent): 'reading' | 'finished' {
  return ev?.kind === 'finished' || (ev?.percentage ?? 0) >= 0.98
    ? 'finished'
    : 'reading';
}
```

Implement a private request helper that always adds the bearer header, adds `content-type: application/x-www-form-urlencoded` for form bodies, classifies 401/403 as `ConnectorOperationError(..., false, true)`, 429 and 5xx as retryable, other 4xx as permanent, and treats malformed successful GET JSON as retryable.

Implement `loadShelves()`, `loadBooks()`, and `loadInventory()` with strict `items` array validation. Join all non-empty author names using `, `. Order candidate insertion using:

```ts
const target = destination(ev);
const opposite = target === 'reading' ? 'finished' : 'reading';
const order: ShelfType[] = [target, opposite, 'to-read', 'loans', 'holds'];
```

Deduplicate by `externalId`, retain all memberships, call `decideMatch(doc.title, doc.author, candidates)`, and return the chosen ID, score, title, and author. Require `doc.title?.trim()` and `doc.author?.trim()` before making HTTP calls.

Validation catches operational errors and returns `{ ok: false, error: 'invalid token' }` for authentication failures, the safe error message for other failures, and `{ ok: true }` for a valid shelf feed.

- [ ] **Step 5: Write failing creation tests**

Append to `test/microblog.test.ts`:

```ts
describe('Micro.blog book creation', () => {
  it('creates directly on the event destination shelf', async () => {
    const fake = makeMicroblogTransport({ createResponse: { id: 90 } });
    const match = await _microblog.createBook(CRED, DOC, EV, fake.transport);
    expect(match?.externalId).toBe('90');
    const create = fake.calls.find((call) => call.url.endsWith('/books') && call.method === 'POST');
    expect(new URLSearchParams(create!.body!).get('bookshelf_id')).toBe('10');
    expect(new URLSearchParams(create!.body!).get('title')).toBe(DOC.title);
    expect(new URLSearchParams(create!.body!).get('author')).toBe(DOC.author);
  });

  it('recovers the new id from the destination shelf when the response omits it', async () => {
    const fake = makeMicroblogTransport({ createResponse: {} });
    expect((await _microblog.createBook(CRED, DOC, EV, fake.transport))?.externalId).toBeTruthy();
    expect(fake.calls.filter((call) => call.url.endsWith('/books/bookshelves/10'))).toHaveLength(1);
  });

  it('does not create with incomplete metadata', async () => {
    const fake = makeMicroblogTransport();
    expect(await _microblog.createBook(CRED, { ...DOC, author: null }, EV, fake.transport)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('fails permanently when creation cannot recover a real id', async () => {
    const fake = makeMicroblogTransport({ createResponse: {} });
    fake.shelves.set('reading', []);
    fake.disableCreateMutation();
    await expect(_microblog.createBook(CRED, DOC, EV, fake.transport)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('fails permanently when the destination shelf is absent', async () => {
    const fake = makeMicroblogTransport({ omitShelves: ['reading'] });
    await expect(_microblog.createBook(CRED, DOC, EV, fake.transport)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('treats a malformed successful shelf feed as retryable', async () => {
    const fake = makeMicroblogTransport();
    fake.fail('GET', '/books/bookshelves', 200, { unexpected: true });
    await expect(_microblog.createBook(CRED, DOC, EV, fake.transport)).rejects.toMatchObject({
      retryable: true,
    });
  });
});
```

Add `disableCreateMutation()` to the test helper as a boolean switch. Normal creation still mutates the destination shelf even when `createResponse` is `{}`, allowing the recovery test to find the generated ID.

- [ ] **Step 6: Run creation tests and verify the expected failure**

Run: `npm test -- test/microblog.test.ts -t 'Micro.blog book creation'`

Expected: FAIL because `_microblog.createBook` is missing.

- [ ] **Step 7: Implement creation and ID recovery**

Implement `createBook()` to load shelf definitions, require the destination shelf, form-encode title/author/bookshelf ID, and POST `/books`. Accept response IDs from `id`, `book_id`, `item.id`, or `book.id`, normalizing numbers and strings to a non-empty string. Treat an empty or non-JSON successful response as ID-less. If no ID is present, fetch only the destination shelf and use `decideMatch()` with the same required title and author. Throw a permanent `ConnectorOperationError('Micro.blog created the book but did not return or expose its id', false)` when recovery finds nothing.

Export only stable test seams:

```ts
export const _microblog = {
  validateCredential,
  extractBooks,
  matchBook,
  createBook,
};
```

- [ ] **Step 8: Run the Micro.blog tests**

Run: `npm test -- test/microblog.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/connectors/microblog.ts test/microblog-helpers.ts test/microblog.test.ts
git commit -m "feat: add Micro.blog shelf matching and book creation"
```

---

### Task 3: Implement idempotent shelf reconciliation

**Files:**
- Modify: `src/connectors/microblog.ts`
- Modify: `test/microblog.test.ts`

**Interfaces:**
- Consumes: `_microblog.matchBook`, `_microblog.createBook`
- Produces: `_microblog.reconcileBook(cred, match, ev, http): Promise<PushResult>`
- Produces: `microblogConnector: Connector`

- [ ] **Step 1: Write failing reconciliation tests**

Append tests that assert final state as well as call order:

```ts
describe('Micro.blog shelf reconciliation', () => {
  const book = { id: '50', title: DOC.title!, author: DOC.author! };

  it('assigns currently reading before removing want to read', async () => {
    const fake = makeMicroblogTransport({ shelves: { 'to-read': [book] } });
    expect(await _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport)).toEqual({ ok: true });
    expect(fake.shelves.get('reading')).toContainEqual(book);
    expect(fake.shelves.get('to-read')).not.toContainEqual(book);
    const writes = fake.calls.filter((call) => call.method !== 'GET');
    expect(writes.map((call) => call.method)).toEqual(['POST', 'DELETE']);
    expect(writes[0].url).toContain('/books/bookshelves/10/assign');
    expect(writes[1].url).toContain('/books/bookshelves/12/remove/50');
  });

  it('moves a currently reading book to finished', async () => {
    const fake = makeMicroblogTransport({ shelves: { reading: [book] } });
    const finished = { kind: 'finished' as const, document: 'd', percentage: 1, timestamp: 2 };
    await _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, finished, fake.transport);
    expect(fake.shelves.get('finished')).toContainEqual(book);
    expect(fake.shelves.get('reading')).not.toContainEqual(book);
  });

  it('moves a finished book back to currently reading for a later partial event', async () => {
    const fake = makeMicroblogTransport({ shelves: { finished: [book] } });
    await _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport);
    expect(fake.shelves.get('reading')).toContainEqual(book);
    expect(fake.shelves.get('finished')).not.toContainEqual(book);
  });

  it('preserves loans and holds while assigning reading', async () => {
    const fake = makeMicroblogTransport({ shelves: { loans: [book], holds: [book] } });
    await _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport);
    expect(fake.shelves.get('loans')).toContainEqual(book);
    expect(fake.shelves.get('holds')).toContainEqual(book);
    expect(fake.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  it('does no writes when already in the desired managed state', async () => {
    const fake = makeMicroblogTransport({ shelves: { reading: [book] } });
    await _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport);
    expect(fake.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('classifies authentication, rate-limit, server, and request failures', async () => {
    for (const [status, retryable, needsReauth] of [
      [401, false, true], [403, false, true], [429, true, false],
      [500, true, false], [422, false, false],
    ] as const) {
      const fake = makeMicroblogTransport({ shelves: { reading: [book] } });
      fake.fail('GET', '/books/bookshelves', status);
      await expect(
        _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport)
      ).rejects.toMatchObject({ retryable, needsReauth });
    }
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run: `npm test -- test/microblog.test.ts -t 'Micro.blog shelf reconciliation'`

Expected: FAIL because `_microblog.reconcileBook` is missing.

- [ ] **Step 3: Implement reconciliation and the connector object**

Implement `reconcileBook()` by loading the relevant shelf inventory, finding membership by `match.externalId`, assigning destination when absent, removing from `to-read` when present, then removing from the opposite reading state when present. Form-encode assignment exactly as:

```ts
new URLSearchParams({ book_id: match.externalId }).toString()
```

Use encoded shelf and book path segments for DELETE URLs. Never iterate over `loans` or `holds` in removal code.

Export the connector:

```ts
export const microblogConnector: Connector = {
  id: 'microblog',
  displayName: 'Micro.blog',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'token',
  experimental: false,
  matchBy: 'metadata',
  shouldPush: (ev) => !(ev.kind === 'progress' && (ev.percentage ?? 0) <= 0),
  validate: validateCredential,
  match: matchBook,
  createBook,
  push: reconcileBook,
};
```

Add `reconcileBook` and `destination` to `_microblog` for focused tests.

- [ ] **Step 4: Run connector tests and build**

Run: `npm test -- test/microblog.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/microblog.ts test/microblog.test.ts
git commit -m "feat: reconcile Micro.blog reading shelves"
```

---

### Task 4: Wire creation, no-op filtering, and typed failures into the queue runner

**Files:**
- Modify: `src/connectors/runner.ts:20-139`
- Modify: `src/connectors/registry.ts:1-15`
- Modify: `test/connectors.test.ts:48-60`
- Create: `test/microblog-integration.test.ts`

**Interfaces:**
- Consumes: `Connector.shouldPush`, event-aware `Connector.match`, `Connector.createBook`, `ConnectorOperationError`
- Changes: `resolveMatch(db, connectorId, userId, document, http, ev?)`
- Produces: registered connector ID `microblog`

- [ ] **Step 1: Write failing runner integration tests**

Create `test/microblog-integration.test.ts` with this setup and the concrete queue cases:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { enqueue } from '../src/connectors/queue.js';
import { drainQueue } from '../src/connectors/runner.js';
import { saveMatch } from '../src/connectors/store.js';
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

async function sync(app: TestServer['app'], headers: Record<string, string>, percentage: number) {
  await app.request('/syncs/progress', {
    method: 'PUT', headers,
    body: JSON.stringify({ document: DOC, progress: 'p', percentage, device_id: 'd1' }),
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
```

Update the management-list expectation in `test/connectors.test.ts` to include `microblog`:

```ts
expect(ids).toEqual(['audiobookshelf', 'bookfusion', 'hardcover', 'kosync', 'microblog']);
```

- [ ] **Step 2: Run the integration tests and verify the expected failure**

Run: `npm test -- test/microblog-integration.test.ts test/connectors.test.ts`

Expected: FAIL because Micro.blog is not registered and the runner does not invoke lifecycle hooks.

- [ ] **Step 3: Register Micro.blog**

Import `microblogConnector` in `src/connectors/registry.ts` and append it to `CONNECTORS`.

- [ ] **Step 4: Make matching event-aware and create only after a genuine miss**

Change `resolveMatch` to accept `ev?: OutboundEvent`, pass `ev` as the fourth argument to `connector.match`, and, after matching returns null, call:

```ts
if (!match && ev && connector.createBook) {
  match = await connector.createBook(cred, meta, ev, http);
}
```

Keep this block after both early cached-match returns. In particular, the existing manual-source early return must stay above it so a manual null match never creates a book. Save only the real returned match through the existing `saveMatch` call.

- [ ] **Step 5: Filter no-op events and handle typed errors consistently**

At the start of `processRow`, after account checks, parse `row.payload` into `ev`. If `connector.shouldPush?.(ev) === false`, call `markDone(db, row.id)` and return before matching.

Add a runner helper:

```ts
function failOperation(db: DB, row: QueueRow, err: unknown, prefix: string): void {
  const error = `${prefix}: ${errStr(err)}`;
  const retryable = err instanceof ConnectorOperationError ? err.retryable : true;
  if (err instanceof ConnectorOperationError && err.needsReauth) {
    setAccountStatus(db, row.user_id, row.connector_id, 'needs_reauth', err.message);
  }
  logPushFailure(row, error, retryable);
  markFailed(db, row, error, retryable);
}
```

Use it in both the resolve/create catch and the push catch. Continue handling returned `PushResult` exactly as today. Call `resolveMatch(..., http, ev)` and remove the later duplicate payload parse.

- [ ] **Step 6: Run focused integration tests**

Run: `npm test -- test/microblog-integration.test.ts test/connectors.test.ts test/connectors-more.test.ts`

Expected: PASS, including existing connector behavior.

- [ ] **Step 7: Commit**

```bash
git add src/connectors/runner.ts src/connectors/registry.ts test/connectors.test.ts test/microblog-integration.test.ts
git commit -m "feat: run Micro.blog reconciliation through connector queue"
```

---

### Task 5: Add Micro.blog setup copy and project documentation

**Files:**
- Modify: `src/routes/web.ts:21-29,220-235,527-533`
- Modify: `README.md:6-18,53-62`
- Create: `test/web-microblog.test.ts`

**Interfaces:**
- Produces: public Micro.blog service description
- Produces: token-link guidance pointing to Account → Edit Apps
- Changes: connector encryption documentation to describe all external-service connectors

- [ ] **Step 1: Write failing web-copy tests**

Create `test/web-microblog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('Micro.blog web setup', () => {
  it('lists Micro.blog on the public services page', async () => {
    const { app } = makeTestApp();
    const html = await (await app.request('/')).text();
    expect(html).toContain('Micro.blog');
    expect(html).toContain('Currently reading');
    expect(html).toContain('Finished reading');
  });

  it('explains where to create the pasted app token', async () => {
    const { app } = makeTestApp();
    const signup = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `web-${Date.now()}` }),
    });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const html = await (await app.request('/link/microblog', { headers: { cookie } })).text();
    expect(html).toContain('Account');
    expect(html).toContain('Edit Apps');
    expect(html).toContain('Micro.blog app token');
  });
});
```

- [ ] **Step 2: Run the web tests and verify the expected failure**

Run: `npm test -- test/web-microblog.test.ts`

Expected: FAIL because the current HTML has no Micro.blog copy.

- [ ] **Step 3: Add UI copy**

Add `microblog` to the optional service icon ID list in `src/routes/web.ts`. Add this service card after Hardcover:

```html
<div class="svc"><div class="lead"><img class="svc-icon" src="/icons/microblog.png" alt="" width="34" height="34"><div><div class="name">Micro.blog</div>
  <div class="desc">Keep your Currently reading and Finished reading bookshelves up to date automatically.</div></div></div>
  <span class="pill">ready</span></div>
```

Add this entry to `HINTS`:

```js
microblog: 'Paste your Micro.blog app token from Account → Edit Apps. Keeps your Currently reading and Finished reading bookshelves in sync.',
```

The generic token form remains unchanged.

- [ ] **Step 4: Update README**

Add this feature bullet after the multi-device sync bullet:

```md
- **Server-side service connectors.** Link services such as Hardcover, Micro.blog, and Audiobookshelf once; readers continue speaking standard KOSync while the server updates external reading state.
```

Change the `TOKEN_ENC_KEY` row to:

```md
| `TOKEN_ENC_KEY` | _(unset)_ | Enables external-service connectors. 64 hex chars, a base64 32-byte key, or a ≥32-char passphrase. Encrypts stored connector credentials at rest; unset = connectors disabled. |
```

- [ ] **Step 5: Run web tests and documentation checks**

Run: `npm test -- test/web-microblog.test.ts && npm run build && git diff --check`

Expected: PASS with no whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/web.ts README.md test/web-microblog.test.ts
git commit -m "docs: add Micro.blog connector setup guidance"
```

---

### Task 6: Complete regression and acceptance verification

**Files:**
- Modify only if a failing verification reveals an implementation defect in files already listed above.

**Interfaces:**
- Verifies: all acceptance criteria in the design spec

- [ ] **Step 1: Run the Micro.blog-focused suite**

Run: `npm test -- test/connector-lifecycle.test.ts test/microblog.test.ts test/microblog-integration.test.ts test/web-microblog.test.ts`

Expected: PASS.

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: all tests pass with no unhandled errors or warnings.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: TypeScript compilation succeeds.

- [ ] **Step 4: Check the final diff and repository state**

Run: `git diff --check && git status --short && git log --oneline --decorate -8`

Expected: no whitespace errors; only intentional uncommitted corrections, if any, are shown.

- [ ] **Step 5: Commit any verification correction**

If Step 1–4 required a code correction, stage only the corrected files and commit:

```bash
git add README.md src/connectors/types.ts src/connectors/microblog.ts src/connectors/runner.ts src/connectors/registry.ts src/routes/web.ts test/connector-lifecycle.test.ts test/microblog-helpers.ts test/microblog.test.ts test/microblog-integration.test.ts test/web-microblog.test.ts
git commit -m "fix: complete Micro.blog connector verification"
```

If no correction was required, do not create an empty commit.
