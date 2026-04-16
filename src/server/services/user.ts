import { User, ProjectUser } from '../models/User';

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export interface UserIdentity {
  id: number;
  email: string;
  role: 'admin' | 'user';
}

/** Synthetic identity for local/LAN connections (no DB record) */
export const LOCAL_ADMIN: UserIdentity = { id: 0, email: 'local', role: 'admin' };

class UserService {
  async findOrCreate(email: string): Promise<UserIdentity> {
    const normalized = email.toLowerCase();
    const role = ADMIN_EMAILS.includes(normalized) ? 'admin' : 'user';

    let user = await User.findOneBy({ email: normalized });
    if (!user) {
      user = User.create({
        email: normalized,
        role,
        createdAt: new Date().toISOString(),
      }) as User;
      await user.save();
      console.log(`[user] created user: ${normalized} (${role})`);
    } else if (user.role !== role) {
      user.role = role;
      await user.save();
      console.log(`[user] updated role for ${normalized}: ${role}`);
    }

    return { id: user.id, email: user.email, role: role as 'admin' | 'user' };
  }

  async visibleProjectIds(identity: UserIdentity): Promise<number[] | 'all'> {
    if (identity.role === 'admin') {
      console.log(`[user:${identity.id}] visibleProjectIds: admin, returning all`);
      return 'all';
    }
    const rows = await ProjectUser.findBy({ userId: identity.id });
    return rows.map((r) => r.projectId);
  }

  async listUsers(): Promise<Array<{ id: number; email: string; role: string }>> {
    const users = await User.find({ order: { email: 'ASC' } });
    return users.map((u) => ({ id: u.id, email: u.email, role: u.role }));
  }

  async projectUserIds(projectId: number): Promise<number[]> {
    const rows = await ProjectUser.findBy({ projectId });
    return rows.map((r) => r.userId);
  }

  async setProjectUsers(projectId: number, userIds: number[]): Promise<void> {
    await ProjectUser.delete({ projectId });
    if (userIds.length > 0) {
      const rows = userIds.map((userId) => ({ projectId, userId }));
      await ProjectUser.insert(rows);
    }
  }
}

export const userService = new UserService();
