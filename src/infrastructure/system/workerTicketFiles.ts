/**
 * Where a worker ticket's token is handed over: one file per ticket, mode 0600
 * in a 0700 directory the bot owns. The brief names the PATH, never the token,
 * so the secret is not in the brain's context, a spec, an Orca task record or a
 * Slack message. The file is deleted when the ticket ends.
 *
 * Honest limit: an Orca worker runs as the same host user as the bot, so the
 * file mode cannot keep out another process of that user. What it does keep the
 * token out of is everything that is merely READ or POSTED; a lower-role turn is
 * kept away from the directory by the tool policy, not by the OS.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerTicketFiles } from "../../application/workerTickets.ts";

/**
 * Line 1 is the token. Line 2, when `baseUrl` is given, is where to reach the bot (its
 * loopback dashboard origin): a worker's shell has no `DASHBOARD_PORT`, so the helper scripts
 * read it from here. A file with one line (written before this) falls back to their default.
 */
export const createWorkerTicketFiles = (dir: string, baseUrl?: string): WorkerTicketFiles => ({
  write: (id, token) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = join(dir, id);
    writeFileSync(path, `${token}\n${baseUrl ? `${baseUrl}\n` : ""}`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  },
  remove: (id) => rmSync(join(dir, id), { force: true }),
});
