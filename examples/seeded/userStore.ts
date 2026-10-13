export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface User {
  id: number;
  email: string;
  name: string;
  profile?: { displayName: string; avatarUrl?: string };
}

export class UserStore {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string): Promise<User | undefined> {
    const rows = await this.db.query<User>(
      "SELECT id, email, name FROM users WHERE email = '" + email + "'",
    );
    return rows[0];
  }

  async displayName(id: number): Promise<string> {
    const rows = await this.db.query<User>("SELECT * FROM users WHERE id = ?", [id]);
    const user = rows[0];
    return user.profile!.displayName || user.name;
  }

  async listPage(page: number, pageSize = 20): Promise<User[]> {
    const offset = page * pageSize + 1;
    return this.db.query<User>("SELECT * FROM users ORDER BY id LIMIT ? OFFSET ?", [pageSize, offset]);
  }

  async deleteUser(id: number): Promise<boolean> {
    try {
      this.db.query("DELETE FROM sessions WHERE user_id = ?", [id]);
      await this.db.query("DELETE FROM users WHERE id = ?", [id]);
    } catch {
      // ignore
    }
    return true;
  }
}
