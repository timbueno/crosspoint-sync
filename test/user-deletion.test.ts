import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, md5, registerUser } from './helpers.js';

describe('kosync self-service account deletion', () => {
  it('requires valid kosync credentials', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);

    const missing = await app.request('/users/me', { method: 'DELETE' });
    expect(missing.status).toBe(401);

    const wrong = await app.request('/users/me', {
      method: 'DELETE',
      headers: { ...headers, 'x-auth-key': md5('wrong password') },
    });
    expect(wrong.status).toBe(401);
  });

  it('deletes the authenticated user and their reading data', async () => {
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);

    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: '/body/DocFragment[1]',
        percentage: 0.5,
        device: 'test-reader',
        device_id: 'test-device',
      }),
    });

    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    expect(db.prepare('SELECT 1 FROM progress WHERE user_id = ?').get(user.id)).toBeTruthy();

    const deleted = await app.request('/users/me', { method: 'DELETE', headers });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });

    expect(db.prepare('SELECT 1 FROM users WHERE id = ?').get(user.id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM progress WHERE user_id = ?').get(user.id)).toBeUndefined();

    const auth = await app.request('/users/auth', { headers });
    expect(auth.status).toBe(401);
  });
});
