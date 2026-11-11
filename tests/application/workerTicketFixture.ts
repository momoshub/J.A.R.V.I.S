/** An in-memory worker-ticket store: a real repo on `:memory:` and a fake token-file directory. */
import { createWorkerTickets, type WorkerTicketGrant, type WorkerTickets } from "../../src/application/workerTickets.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createWorkerTicketRepo, type WorkerTicketRepo } from "../../src/infrastructure/db/workerTicketRepo.ts";

export const TICKET_DIR = "/tickets";

export type TicketRig = {
  tickets: WorkerTickets;
  repo: WorkerTicketRepo;
  /** id -> token, for every file that exists right now. */
  files: Map<string, string>;
  /** The token the worker would read from the file of `id`. */
  tokenOf: (id: string) => string;
  /** Mint and return what the worker would have: the id and the token read back from its file. */
  mint: (grant: WorkerTicketGrant) => { id: string; token: string; file: string };
};

export const ticketRig = (now: () => number = () => 1000, repo?: WorkerTicketRepo): TicketRig => {
  const store = repo ?? createWorkerTicketRepo(openDatabase(":memory:"));
  const files = new Map<string, string>();
  let n = 0;
  const tickets = createWorkerTickets(now, {
    repo: store,
    files: {
      write: (id, token) => {
        files.set(id, token);
        return `${TICKET_DIR}/${id}`;
      },
      remove: (id) => void files.delete(id),
    },
    newToken: () => `jvwk_tok${String(++n).padStart(16, "0")}`,
  });
  const tokenOf = (id: string): string => files.get(id) ?? "";
  return {
    tickets,
    repo: store,
    files,
    tokenOf,
    mint: (grant) => {
      const { id, file } = tickets.issue(grant);
      return { id, file, token: tokenOf(id) };
    },
  };
};
