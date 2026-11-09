/**
 * Owner seeding.
 *
 * Guarantees the configured owner exists with the `owner` role. Safe to run
 * repeatedly - it only ever promotes the owner, never downgrades anyone.
 * Runnable directly (`bun run db:seed`) or imported at boot.
 */
import type { Clock } from "../../application/ports.ts";
import type { UserRepo } from "./userRepo.ts";

export const seedOwner = (users: UserRepo, ownerSlackId: string, clock: Clock): void => {
  const existing = users.get(ownerSlackId);
  if (existing?.role === "owner") return;
  users.upsert({
    slackId: ownerSlackId,
    role: "owner",
    displayName: existing?.displayName ?? "",
    addedBy: "system",
    createdAt: existing?.createdAt ?? clock(),
  });
};

if (import.meta.main) {
  const { loadConfig } = await import("../../config/env.ts");
  const { openDatabase } = await import("./client.ts");
  const { createUserRepo } = await import("./userRepo.ts");
  const config = loadConfig();
  const { adoptDatabase } = await import("./location.ts");
  adoptDatabase(config.databasePath, config.databaseMigrateFrom, { log: console.log });
  const db = openDatabase(config.databasePath);
  seedOwner(createUserRepo(db), config.ownerSlackId, () => Date.now());
  console.log(`Seeded owner ${config.ownerSlackId} into ${config.databasePath}`);
}
