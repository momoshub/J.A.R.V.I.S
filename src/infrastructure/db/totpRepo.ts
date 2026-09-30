/**
 * Stored 2FA seeds, in the same encrypted database as the user tokens.
 *
 * A seed is shared, not personal: it belongs to an account the team logs into
 * (a staging demo login, a shared vendor portal), which is the only reason it is
 * here at all. Whose it is stays visible - every row records who added it - so
 * a seed nobody can account for is obvious in `list` rather than silent.
 *
 * Nothing on this port returns the seed itself. The only way out is a six-digit
 * code that expires in under a minute, so no caller can render the credential
 * into a channel even by mistake.
 */
import { Database } from "bun:sqlite";
import { parseOtpauth, type TotpConfig } from "../../domain/totp.ts";
import { seal, unseal } from "./secretBox.ts";
import type { TotpPort } from "../../application/totp.ts";

export const createTotpRepo = (db: Database, key: Buffer, now: () => number = () => Date.now()): TotpPort => {
  const getStmt = db.query<{ sealed: string }, [string]>("SELECT sealed FROM totp_secrets WHERE label = ?");
  const setStmt = db.query(
    `INSERT INTO totp_secrets (label, sealed, account, added_by, updated_at)
     VALUES ($label, $sealed, $account, $by, $at)
     ON CONFLICT(label) DO UPDATE SET sealed = excluded.sealed, account = excluded.account,
       added_by = excluded.added_by, updated_at = excluded.updated_at`,
  );
  const removeStmt = db.query("DELETE FROM totp_secrets WHERE label = $label");
  const listStmt = db.query<{ label: string; account: string | null; added_by: string; updated_at: number }, []>(
    "SELECT label, account, added_by, updated_at FROM totp_secrets ORDER BY label ASC",
  );

  const get = (label: string): TotpConfig | undefined => {
    const row = getStmt.get(label);
    if (!row) return undefined;
    const uri = unseal(row.sealed, key);
    // A row that will not open reads as absent, the same as a missing one: a
    // rotated key should send someone back to `add`, not crash the command.
    return uri ? parseOtpauth(uri) : undefined;
  };

  return {
    get,
    has: (label) => get(label) !== undefined,
    set: (label, uri, addedBy, account) => {
      setStmt.run({
        $label: label,
        $sealed: seal(uri, key),
        $account: account ?? null,
        $by: addedBy,
        $at: now(),
      });
    },
    remove: (label) => {
      const existed = getStmt.get(label) !== null;
      removeStmt.run({ $label: label });
      return existed;
    },
    list: () =>
      listStmt.all().map((r) => ({
        label: r.label,
        account: r.account ?? undefined,
        addedBy: r.added_by,
        updatedAt: r.updated_at,
      })),
  };
};
