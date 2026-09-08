# Micro.blog Bookshelves Connector Design

**Status:** Approved in chat; awaiting written-spec review

## Goal

Add a Micro.blog connector that reflects CrossPoint Sync reading state in the user's Micro.blog bookshelves. Books with progress above 0% and below CrossPoint Sync's existing 98% completion threshold belong on "Currently reading". Books at or above 98% belong on "Finished reading". A 0% event does not change Micro.blog.

The connector must reuse an existing Micro.blog book whenever it can conservatively identify one by title and author. Before it creates a new book, it must inspect the reading, finished, want-to-read, loans, and holds shelves. It may remove a matched book from want-to-read or the opposite reading-state shelf, but it must never remove a book from loans or holds.

## Scope

Version 1 is a one-way, server-side connector:

- Authentication uses a manually pasted Micro.blog app token.
- CrossPoint Sync sends reading-state changes to Micro.blog.
- Micro.blog does not send reading progress back to CrossPoint Sync.
- The connector manages only the default `reading`, `finished`, and `to-read` shelf states.
- The connector reads `loans` and `holds` only to reuse an existing book ID.
- Ratings, reviews, reading dates, cover changes, custom shelves, and OAuth/IndieAuth are out of scope.

## External API

All requests use `https://micro.blog` and send the app token as `Authorization: Bearer <token>`.

The connector uses the documented Books API operations:

- `GET /books/bookshelves` discovers shelf IDs by `_microblog.type`.
- `GET /books/bookshelves/:id` lists books and their Micro.blog IDs.
- `POST /books` creates a book with form-encoded `title`, `author`, and `bookshelf_id`.
- `POST /books/bookshelves/:id/assign` assigns an existing `book_id` to a shelf.
- `DELETE /books/bookshelves/:shelfId/remove/:bookId` removes a book from a shelf.

Automatic matching searches only the user's relevant shelves, preserving stable bookshelf IDs and avoiding accidental creation. For manual matching, the Matches page uses Micro.blog's authenticated `GET /books/search` JSON Feed endpoint to offer catalog results by title. It retains each result's `_microblog.isbn` so a catalog result can be resolved onto a shelf with the `isbn` assignment parameter instead of misusing an ISBN-shaped feed ID as an integer `book_id`.

## Connector Contract

The existing `Connector.match()` method gains an optional outbound-event argument:

```ts
match(
  cred: Credential,
  doc: DocumentMeta,
  http: HttpTransport,
  ev?: OutboundEvent
): Promise<Match | null>;
```

Existing connectors may ignore the optional argument. The runner supplies it during queue processing, while explicit rematch and review operations may omit it. Micro.blog uses it only to prefer a candidate already on the event's destination shelf; when no event is available, it uses the stable order `reading`, `finished`, `to-read`, `loans`, `holds`.

The interface also gains one optional event-aware creation hook:

```ts
createBook?(
  cred: Credential,
  doc: DocumentMeta,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<Match | null>;
```

It also gains an optional event filter:

```ts
shouldPush?(ev: OutboundEvent): boolean;
```

`match()` remains read-only. The queue runner calls `createBook()` only when all of these conditions hold:

1. The connector has the hook.
2. The event is actionable for that connector.
3. No cached real match exists.
4. There is no manual "do not match" override.
5. Read-only matching found no acceptable existing book.

The runner saves a successfully created real ID through the existing match store before pushing the event. Other connectors are unaffected because the hook is optional.

The runner must parse the outbound event before resolving a Micro.blog match. When `shouldPush()` returns false, the runner marks the row done without shelf discovery, matching, creation, or mutation. Micro.blog returns false for a progress event with `percentage <= 0`; connectors without the optional predicate preserve current behavior.

Connector HTTP code also gains a typed operational error carrying `retryable` and `needsReauth` flags. The runner recognizes this error during both matching and creation, updates account status when needed, and dead-letters or retries consistently. Unknown exceptions retain the current retryable behavior, so existing connectors are unaffected.

## Connector Metadata

The connector is registered with:

```ts
{
  id: 'microblog',
  displayName: 'Micro.blog',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'token',
  experimental: false,
  matchBy: 'metadata'
}
```

Both title and author are required for automatic matching and creation. Missing either field produces no automatic match and no book creation. The book remains available in the existing manual match review workflow.

## Authentication

The existing generic token form stores the Micro.blog app token using the encrypted connector-account store. Linking validates the token by requesting `GET /books/bookshelves`, which verifies access to the exact API the connector needs without exchanging or rotating the token.

A 401 or 403 rejects linking. On a later push, either status produces a non-retryable result with `needsReauth: true`. The UI explains that the token comes from Micro.blog's Account → Edit Apps page.

## Shelf Inventory and Matching

For each uncached match, the connector:

1. Fetches the shelf list.
2. Finds shelf IDs by stable `_microblog.type`, never by display title.
3. Fetches books from `reading`, `finished`, `to-read`, `loans`, and `holds` shelves that exist.
4. Converts each valid item to an `ExternalBook` using its item `id`, `title`, and joined author names.
5. Requires non-empty CrossPoint Sync title and author metadata.
6. Uses the repository's `decideMatch()` helper with its existing 0.6 threshold and 0.15 ambiguity margin after confirming both requested fields are present.

When equivalent candidates exist on multiple shelves, candidate selection uses this precedence:

1. The event's destination shelf.
2. The opposite reading-state shelf.
3. `to-read`.
4. `loans`.
5. `holds`.

This makes an already-correct record stable, enables status transitions without duplication, honors the user's request to check want-to-read before Libby-derived shelves, and still reuses loans or holds before creating a new book. Duplicate appearances of the same book ID are collapsed while retaining all shelf memberships.

The connector caches the selected Micro.blog book ID in `connector_matches`. Subsequent events reuse the cached ID and inspect current shelf membership by ID rather than repeating fuzzy identity selection.

## Creation

If no existing candidate is accepted, `createBook()` posts the title, author, and destination `bookshelf_id` to `POST /books`. It omits ISBN and cover URL because CrossPoint Sync's canonical metadata does not currently provide them.

The Books API documentation does not define the create response body. The connector therefore supports these safe outcomes:

- If a valid book ID is present in the response, return it.
- If a successful response is empty, non-JSON, or valid JSON without an ID, treat it as ID-less, then re-fetch the destination shelf and locate the newly created book using the same required title-and-author matching policy.

If neither method yields a real ID, creation fails without caching a synthetic value. The queue may retry only when the HTTP status or transport failure is retryable.

## Reconciliation

Destination is derived from the canonical event:

- `progress` with `0 < percentage < 0.98` → `reading`
- `finished`, or any event with `percentage >= 0.98` → `finished`
- `progress` with `percentage <= 0` → no-op

For an existing book, `push()` loads relevant shelves and records every membership for the matched ID. It then performs mutations in this order:

1. If the ID is not on the destination shelf, assign it there.
2. If the ID is on `to-read`, remove it from `to-read`.
3. If the ID is on the opposite reading-state shelf, remove it from that shelf.

The connector never sends a remove request for `loans` or `holds`, even when the same book ID is assigned to a reading-state shelf. It ignores `dnf` and custom shelves. If the book is already only in the desired managed state, the operation makes no writes.

Assignment precedes removal so a partial failure is more likely to leave an extra membership than an unshelved book. A retry observes current membership and converges idempotently.

A book previously marked finished moves back to currently reading if a later canonical event reports progress above 0% and below 98%. CrossPoint Sync remains authoritative for the two managed reading states.

## HTTP and Error Handling

Every response is classified consistently:

- 200–299: parse and validate the operation-specific response.
- 401/403: permanent authentication failure; set `needsReauth` during pushes.
- 429: retryable failure.
- 500–599: retryable failure.
- Other 400-range statuses: permanent request failure.
- Transport exceptions: handled by the existing runner as retryable failures.

Successful shelf-list responses must contain a JSON Feed `items` array. The default `reading`, `finished`, and `to-read` shelves are expected to exist for every account. A required destination shelf that is missing is a permanent configuration/API-shape error. Missing `to-read`, `loans`, or `holds` shelves during lookup are treated as empty optional sources and do not fail matching.

Malformed successful read responses raise the typed operational error rather than being interpreted as empty shelves, preventing accidental duplicate creation. Read-only response-shape failures are retryable because the remote API may have returned a transient proxy or deployment payload. A successful creation response that is empty, non-JSON, or lacks an ID is not itself an error: the connector first performs the documented destination-shelf recovery lookup. If that lookup is well-formed but the new book is absent, the failure is permanent so a retry cannot create duplicates. Error messages include the operation and HTTP status but never include the token.

## User Interface and Documentation

The connector appears in the connector list and uses the existing token-link form. Micro.blog-specific help text says where to create an app token and explains that the connector maintains Currently reading and Finished reading books. Credential submission requires HTTPS except on loopback addresses. Deployments behind an HTTPS-terminating reverse proxy must explicitly enable `TRUST_PROXY`, and direct access must be blocked so clients cannot forge `X-Forwarded-Proto`.

The public services list adds Micro.blog. If no dedicated icon asset is added, the existing broken-image fallback hides the image without blocking the connector. README connector and `TOKEN_ENC_KEY` descriptions are updated to include Micro.blog generically rather than naming only older services.

No new management endpoints or database migration are required.

## Testing

Tests use the injected `HttpTransport`; they make no live Micro.blog calls.

Unit coverage for `src/connectors/microblog.ts` includes:

- Valid and invalid token validation.
- Shelf discovery by `_microblog.type`.
- Book extraction with multiple authors.
- Required title and author metadata.
- Normalized title-and-author matching.
- Destination/opposite/want/loans/holds precedence.
- Duplicate shelf appearances collapsed by book ID.
- Existing IDs on want-to-read, loans, or holds reused instead of creating.
- Loans and holds never removed.
- Assignment before managed-source removal.
- Currently-reading to finished and finished to currently-reading transitions.
- Already-correct state performs no writes.
- Creation directly on the destination shelf.
- Create-response ID parsing and destination-shelf ID recovery.
- 401/403, 429, 5xx, unexpected 4xx, and malformed-success handling.

Runner and integration coverage includes:

- Registration and connector-management API visibility.
- Generic token linking with Micro.blog-specific validation.
- A queued progress event matches or creates and reconciles successfully.
- A queued finished event targets the finished shelf.
- A 0% event completes without any Micro.blog HTTP call.
- Missing title or author does not create a book.
- A manual no-match override suppresses creation.
- Authentication failure marks the linked account as needing reauthorization.

UI tests or focused string assertions cover the link hint and service listing if this repository's current testing style supports them. The complete existing test suite and TypeScript build must pass.

## Security and Operational Properties

- Tokens remain encrypted at rest through the existing credential store.
- Tokens never appear in logs or error messages.
- All Micro.blog calls use HTTPS and a fixed service origin.
- User-provided book metadata is form-encoded, not interpolated into URLs or headers.
- Writes run through the existing durable retry queue.
- Reconciliation is idempotent and safe to repeat after partial failure.
- The connector does not delete books; it only removes managed shelf memberships.

## Acceptance Criteria

The feature is complete when a user can paste a valid Micro.blog app token, link the connector, and sync existing or future CrossPoint Sync books such that:

- 0% books do not change Micro.blog.
- Books above 0% and below 98% end on Currently reading.
- Books at or above 98% end on Finished reading.
- Existing matching books on Want to read, Loans, or Holds are reused.
- Want to read and the opposite reading-state membership are removed after destination assignment.
- Loans and Holds memberships are never explicitly removed.
- New books are created only after all relevant shelves have been checked.
- Missing title or author never triggers automatic matching or creation.
- Repeating the same event produces no unnecessary shelf writes.
- Authentication failures surface as reauthorization-required.
- All tests and the TypeScript build pass.
