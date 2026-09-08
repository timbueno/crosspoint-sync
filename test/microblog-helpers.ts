import type { HttpTransport } from '../src/connectors/types.js';

export interface FakeMicroblogBook {
  id: string;
  title: string;
  author: string;
  isbn?: string;
}

export type FakeShelfType = 'reading' | 'finished' | 'to-read' | 'loans' | 'holds';

export interface FakeMicroblogOptions {
  shelves?: Partial<Record<FakeShelfType, FakeMicroblogBook[]>>;
  createResponse?: unknown;
  createStatus?: number;
  omitShelves?: FakeShelfType[];
  searchItems?: unknown[];
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
    if (init.method === 'GET' && parsed.pathname === '/books/search') {
      return response(200, { version: 'https://jsonfeed.org/version/1.1', items: options.searchItems ?? [] });
    }
    const shelfMatch = parsed.pathname.match(/^\/books\/bookshelves\/(\d+)$/);
    if (init.method === 'GET' && shelfMatch) {
      const type = (Object.keys(ids) as FakeShelfType[]).find((key) => ids[key] === shelfMatch[1]);
      if (!type) return response(404, {});
      return response(200, {
        items: shelves.get(type)!.map((book) => ({
          id: Number(book.id), title: book.title,
          authors: [{ name: book.author }], _microblog: { isbn: book.isbn ?? '' },
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
      return response(options.createStatus ?? 200, configured);
    }
    const assignMatch = parsed.pathname.match(/^\/books\/bookshelves\/(\d+)\/assign$/);
    if (init.method === 'POST' && assignMatch) {
      const target = (Object.keys(ids) as FakeShelfType[]).find((key) => ids[key] === assignMatch[1]);
      const form = new URLSearchParams(init.body);
      const bookId = form.get('book_id');
      const isbn = form.get('isbn');
      let book = [...shelves.values()].flat().find((item) =>
        (bookId && item.id === bookId) || (isbn && item.isbn === isbn)
      );
      if (!book && isbn) {
        const result = options.searchItems?.find((item) =>
          item && typeof item === 'object'
          && (item as { _microblog?: { isbn?: unknown } })._microblog?.isbn === isbn
        ) as { title?: unknown; authors?: Array<{ name?: unknown }> } | undefined;
        if (result && typeof result.title === 'string') {
          book = {
            id: String(nextId++),
            isbn,
            title: result.title,
            author: typeof result.authors?.[0]?.name === 'string' ? result.authors[0].name : '',
          };
        }
      }
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
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    text: async () => serialized,
    json: async () => JSON.parse(serialized),
  };
}
