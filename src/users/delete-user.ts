import type { DB } from '../db/db.js';
import { withTransaction } from '../db/db.js';
import { invalidateAuthCache } from '../auth/middleware.js';

/** Permanently delete a kosync user and every row of its reading data. */
export function deleteKosyncUserData(db: DB, userId: number, username: string): void {
  withTransaction(db, () => {
    for (const table of [
      'connector_queue',
      'connector_matches',
      'connector_accounts',
      'stats_device_book',
      'stats_device_global',
      'clippings',
      'bookmarks',
      'documents',
      'progress',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  invalidateAuthCache(username);
}
