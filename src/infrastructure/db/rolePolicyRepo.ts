/**
 * The old dashboard deny lists (`role_policies`), kept only to be read once.
 *
 * Roles are data now (`roleRepo.ts`); `seedRoles` folds these rows into the
 * built-in roles' grants on the first boot after the change and nothing writes
 * here any more. A role nobody had edited has no row.
 */
import type { DbClient } from "./client.ts";
import { currentCommandName } from "../../domain/rolePolicy.ts";

export type LegacyRolePolicy = {
  readonly role: string;
  readonly enabled: boolean;
  readonly deniedCommands: readonly string[];
  readonly deniedTools: readonly string[];
  readonly deniedMcpServers: readonly string[];
};

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

export const readLegacyPolicies = (db: DbClient): LegacyRolePolicy[] =>
  db
    .query<Row, []>("SELECT * FROM role_policies")
    .all()
    .map((r) => ({
      role: r.role,
      enabled: r.enabled !== 0,
      deniedCommands: strings(r.denied_commands)
        .map(currentCommandName)
        .filter((c): c is string => c !== undefined),
      deniedTools: strings(r.denied_tools),
      deniedMcpServers: strings(r.denied_mcp_servers),
    }));
