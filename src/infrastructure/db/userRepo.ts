/**
 * Allowlist repository - the set of Slack users the bot will talk to.
 *
 * Functional factory: closes over the db handle and returns a bag of functions.
 * No classes, no shared mutable state beyond the connection itself.
 */
import type { DbClient } from "./client.ts";
import type { AllowedUser, UserRole } from "../../domain/types.ts";

type Row = {
  slack_id: string;
  role: UserRole;
  display_name: string;
  added_by: string;
  created_at: number;
};

const toUser = (row: Row): AllowedUser => ({
  slackId: row.slack_id,
  role: row.role,
  displayName: row.display_name,
  addedBy: row.added_by,
  createdAt: row.created_at,
});

export type UserRepo = {
  get: (slackId: string) => AllowedUser | undefined;
  list: () => AllowedUser[];
  upsert: (user: AllowedUser) => AllowedUser;
  setRole: (slackId: string, role: UserRole) => void;
  setDisplayName: (slackId: string, displayName: string) => void;
  remove: (slackId: string) => void;
};

export const createUserRepo = (db: DbClient): UserRepo => {
  const getStmt = db.query<Row, [string]>(
    "SELECT * FROM allowed_users WHERE slack_id = ?",
  );
  const listStmt = db.query<Row, []>(
    "SELECT * FROM allowed_users ORDER BY created_at ASC",
  );
  const upsertStmt = db.query(
    `INSERT INTO allowed_users (slack_id, role, display_name, added_by, created_at)
     VALUES ($slackId, $role, $displayName, $addedBy, $createdAt)
     ON CONFLICT(slack_id) DO UPDATE SET
       role = excluded.role,
       display_name = excluded.display_name`,
  );
  const setRoleStmt = db.query(
    "UPDATE allowed_users SET role = $role WHERE slack_id = $slackId",
  );
  const setNameStmt = db.query(
    "UPDATE allowed_users SET display_name = $displayName WHERE slack_id = $slackId",
  );
  const removeStmt = db.query("DELETE FROM allowed_users WHERE slack_id = $slackId");

  return {
    get: (slackId) => {
      const row = getStmt.get(slackId);
      return row ? toUser(row) : undefined;
    },
    list: () => listStmt.all().map(toUser),
    upsert: (user) => {
      upsertStmt.run({
        $slackId: user.slackId,
        $role: user.role,
        $displayName: user.displayName,
        $addedBy: user.addedBy,
        $createdAt: user.createdAt,
      });
      const row = getStmt.get(user.slackId);
      return toUser(row as Row);
    },
    setRole: (slackId, role) => {
      setRoleStmt.run({ $slackId: slackId, $role: role });
    },
    setDisplayName: (slackId, displayName) => {
      setNameStmt.run({ $slackId: slackId, $displayName: displayName });
    },
    remove: (slackId) => {
      removeStmt.run({ $slackId: slackId });
    },
  };
};
