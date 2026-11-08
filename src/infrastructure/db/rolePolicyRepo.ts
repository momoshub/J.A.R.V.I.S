/**
 * Role policies - whether each role is on, and what it is denied on top of the
 * code's own ceilings. Read on every access check, so it stays a primary-key
 * SELECT; a role nobody has edited has no row and reads as the default.
 */
import type { DbClient } from "./client.ts";
import type { UserRole } from "../../domain/types.ts";
import { ROLES, defaultRolePolicy, type RolePolicy } from "../../domain/rolePolicy.ts";

type Row = {
  role: string;
  enabled: number;
  denied_commands: string;
  denied_tools: string;
  denied_mcp_servers: string;
};

const strings = (json: string): string[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const toPolicy = (role: UserRole, row: Row | null): RolePolicy =>
  row
    ? {
        role,
        enabled: row.enabled !== 0,
        deniedCommands: strings(row.denied_commands),
        deniedTools: strings(row.denied_tools),
        deniedMcpServers: strings(row.denied_mcp_servers),
      }
    : defaultRolePolicy(role);

export type RolePolicyRepo = {
  get: (role: UserRole) => RolePolicy;
  /** Every role, highest first, stored or default. */
  list: () => RolePolicy[];
  save: (policy: RolePolicy, by: string, at: number) => void;
};

export const createRolePolicyRepo = (db: DbClient): RolePolicyRepo => {
  const getStmt = db.query<Row, [string]>("SELECT * FROM role_policies WHERE role = ?");
  const saveStmt = db.query(
    `INSERT INTO role_policies (role, enabled, denied_commands, denied_tools, denied_mcp_servers, updated_by, updated_at)
     VALUES ($role, $enabled, $commands, $tools, $mcp, $by, $at)
     ON CONFLICT(role) DO UPDATE SET
       enabled = excluded.enabled,
       denied_commands = excluded.denied_commands,
       denied_tools = excluded.denied_tools,
       denied_mcp_servers = excluded.denied_mcp_servers,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  );
  const get = (role: UserRole): RolePolicy => toPolicy(role, getStmt.get(role));
  return {
    get,
    list: () => ROLES.map(get),
    save: (policy, by, at) => {
      saveStmt.run({
        $role: policy.role,
        $enabled: policy.enabled ? 1 : 0,
        $commands: JSON.stringify(policy.deniedCommands),
        $tools: JSON.stringify(policy.deniedTools),
        $mcp: JSON.stringify(policy.deniedMcpServers),
        $by: by,
        $at: at,
      });
    },
  };
};
