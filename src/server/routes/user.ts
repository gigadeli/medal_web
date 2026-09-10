/**
 * DELETE /api/user —— 記録を消す (DESIGN_SERVER.md §7.3)
 *
 * 論理削除にしない。`deleted_at` を立てて残す設計にもしない。
 *
 *   > 消したのに識別子が残るのでは消したことになりません。 (DESIGN.md §11.10)
 *
 * これは §8 の不正対策と正面から衝突する。`flagged` を消せてしまうから (§15-2)。
 * それでもプライバシーを優先する、と決めた。
 * 代わりに §8.2 の上限をカウンタ側に効かせてあるので、
 * 消して作り直しても最初からやり直しになるだけになる。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { requireIdentity, clearCookie } from '../middleware/identity.js';
import { deleteUser } from '../db/users.js';

export const userRoutes = new Hono<AppEnv>();

userRoutes.delete('/', requireIdentity, async (c) => {
  // ON DELETE CASCADE で sessions / saves / scores / transfer_codes も消える
  await deleteUser(c.env.DB, c.get('userId'));
  clearCookie(c);
  return c.json({ deleted: true });
});
