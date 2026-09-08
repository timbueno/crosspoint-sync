import { Hono } from 'hono';
import type { DB } from '../db/db.js';
import { authMiddleware, type AppEnv } from '../auth/middleware.js';
import { deleteKosyncUserData } from '../users/delete-user.js';

export function userRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = authMiddleware(db);

  app.delete('/users/me', auth, (c) => {
    const user = c.get('user');
    deleteKosyncUserData(db, user.id, user.username);
    return c.json({ deleted: true });
  });

  return app;
}
