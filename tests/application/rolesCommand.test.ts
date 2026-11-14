import { describe, expect, test } from "bun:test";
import { dispatchCommand, listCommandInfo, type CommandDeps } from "../../src/application/commands.ts";
import { seedRoles } from "../../src/application/roles.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createRoleRepo } from "../../src/infrastructure/db/roleRepo.ts";
import { readLegacyPolicies } from "../../src/infrastructure/db/rolePolicyRepo.ts";
import { createSettingsRepo } from "../../src/infrastructure/db/settingsRepo.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { enforceRolePolicies } from "../../src/application/rolePolicies.ts";
import { toolPolicyFor } from "../../src/domain/toolPolicy.ts";
import { can } from "../../src/domain/roles.ts";
import { actor, OWNER, slackCalls, build } from "./commandsFixture.ts";

/** A command environment over a real in-memory database with the roles seeded, as the bot boots. */
const env = () => {
  const base = build();
  const db = openDatabase(":memory:");
  const settings = createSettingsRepo(db);
  const roleRepo = createRoleRepo(db);
  const users = createUserRepo(db);
  seedRoles({
    repo: roleRepo,
    settings,
    clock: () => 1,
    legacyPolicies: () => readLegacyPolicies(db),
    input: () => ({ commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })), dbServers: [], executerDbServers: [], extraMcpServers: [] }),
  });
  const deps: CommandDeps = { ...base, users, settings, roleRepo, roles: roleRepo.book };
  return { deps, roleRepo, users, settings, db };
};
const owner = () => actor();
const admin = () => actor({ slackId: "U0ADMIN001", role: "admin" });
const run = (deps: CommandDeps, who: ReturnType<typeof actor>, line: string) => dispatchCommand(deps, who, "C1", line);

describe("role command: owner only", () => {
  test("an admin - or a role someone hand-edited to hold command:role - cannot manage roles", async () => {
    const { deps, roleRepo } = env();
    expect(await run(deps, admin(), "role list")).toContain("needs *owner* access");
    // a stored grant that should never exist does not open it
    const a = roleRepo.book.get("admin")!;
    roleRepo.save({ ...a, grants: [...a.grants, "command:role"] }, "x", 2);
    expect(can(roleRepo.book, "admin", "command:role")).toBe(false);
    expect(await run(deps, admin(), "role create sneaky")).toContain("owner");
    expect(roleRepo.book.get("sneaky")).toBeUndefined();
    // and the owner cannot grant it either
    expect(await run(deps, owner(), "role grant executer command:role")).toContain("owner's alone");
  });

  test("list and show describe every role, built-ins included", async () => {
    const { deps } = env();
    const list = await run(deps, owner(), "role list");
    for (const name of ["owner", "admin", "executer", "pal"]) expect(list).toContain(`*${name}*`);
    const show = await run(deps, owner(), "role show executer");
    expect(show).toContain("built in as executer");
    expect(show).toContain("`tools:code`");
    expect(await run(deps, owner(), "role show owner")).toContain("every permission");
    expect(await run(deps, owner(), "role show nobody")).toContain("no role called");
  });
});

describe("custom roles end to end", () => {
  test("create, grant, assign: the new role runs exactly what it was granted", async () => {
    const { deps, users } = env();
    expect(await run(deps, owner(), "role create qa from pal tests things")).toContain("Created *qa*");
    expect(await run(deps, owner(), "role create qa")).toContain("already a role");
    expect(await run(deps, owner(), "role grant qa command:remind github:comment mcp:notion")).toContain("now also grants");
    expect(await run(deps, owner(), "add <@U7> qa")).toContain("is now *qa*");
    const qa = users.get("U7")!;
    expect(qa.role).toBe("qa");
    // granted: a command it did not have as pal-minus... remind is pal's already, tell is admin's
    expect(await run(deps, qa, "tell https://x.slack.com/archives/C1/p1 hi")).toContain("needs *admin*");
    await run(deps, owner(), "role grant qa command:tell");
    expect(await run(deps, qa, "tell https://x.slack.com/archives/C1/p1 hi")).not.toContain("needs");
    // whoami and help show it
    expect(await run(deps, qa, "whoami")).toContain("role: *qa*");
    expect(await run(deps, qa, "whoami")).toContain("tests things");
    const help = await run(deps, qa, "help");
    expect(help).toContain("`tell");
    expect(help).not.toContain("`spend");
    expect(await run(deps, owner(), "users")).toContain("*qa*");
    // revoke takes it back on the very next message
    await run(deps, owner(), "role revoke qa command:tell");
    expect(await run(deps, qa, "tell https://x.slack.com/archives/C1/p1 hi")).toContain("needs *admin*");
  });

  test("the custom role's tool tier follows its grants, with no code change", async () => {
    const { deps, roleRepo } = env();
    await run(deps, owner(), "role create builder from pal");
    expect(toolPolicyFor("builder", { roles: roleRepo.book }).skipPermissions).toBe(false);
    expect(toolPolicyFor("builder", { roles: roleRepo.book }).allowedTools).not.toContain("Bash(git push:*)");
    await run(deps, owner(), "role grant builder tools:code");
    expect(toolPolicyFor("builder", { roles: roleRepo.book }).allowedTools).toContain("Bash(git push:*)");
    expect(toolPolicyFor("builder", { roles: roleRepo.book }).disallowedTools).toContain("Bash(orca:*)");
    await run(deps, owner(), "role grant builder tools:orca");
    expect(toolPolicyFor("builder", { roles: roleRepo.book }).disallowedTools).not.toContain("Bash(orca:*)");
    await run(deps, owner(), "role grant builder tools:full-access");
    expect(toolPolicyFor("builder", { roles: roleRepo.book }).skipPermissions).toBe(true);
    await run(deps, owner(), "role denytools builder Bash(rm:*)");
    expect(toolPolicyFor("builder", { roles: roleRepo.book }).disallowedTools).toContain("Bash(rm:*)");
  });

  test("grant refuses what is not a permission, and families expand", async () => {
    const { deps, roleRepo } = env();
    await run(deps, owner(), "role create tiny");
    expect(await run(deps, owner(), "role grant tiny command:definitely-not")).toContain("Not a permission");
    expect(await run(deps, owner(), "role grant tiny")).toContain("role grant <role>");
    expect(await run(deps, owner(), "role grant tiny github:*")).toContain("`github:pr-merge`");
    expect(roleRepo.book.get("tiny")?.grants.filter((g) => g.startsWith("github:"))).toHaveLength(12);
    expect(await run(deps, owner(), "role grant owner command:ping")).toContain("cannot be edited");
    expect(await run(deps, owner(), "role create Bad Name")).toBeDefined();
    expect(await run(deps, owner(), "role create owner")).toContain("built in");
    expect(await run(deps, owner(), "role create list")).toContain("role` command uses");
  });

  test("delete is refused while people hold the role, and names them; then it goes", async () => {
    const { deps, users, roleRepo } = env();
    await run(deps, owner(), "role create qa from pal");
    await run(deps, owner(), "add <@U7> qa");
    const refused = await run(deps, owner(), "role delete qa");
    expect(refused).toContain("1 person holds *qa*");
    expect(refused).toContain("<@U7>");
    expect(roleRepo.book.get("qa")).toBeDefined();
    await run(deps, owner(), "add <@U7> pal");
    expect(await run(deps, owner(), "role delete qa")).toContain("Deleted *qa*");
    expect(users.get("U7")?.role).toBe("pal");
    expect(await run(deps, owner(), "role delete owner")).toContain("cannot be edited");
    // the role approvals land on stays, even with nobody in it
    users.remove("U7");
    expect(await run(deps, owner(), "role delete pal")).toContain("approved access request");
  });

  test("rename moves everyone along; rank, describe, on/off and default work", async () => {
    const { deps, users, roleRepo, settings } = env();
    await run(deps, owner(), "role create qa from pal");
    await run(deps, owner(), "add <@U7> qa");
    expect(await run(deps, owner(), "role rename qa testers")).toContain("Renamed");
    expect(users.get("U7")?.role).toBe("testers");
    expect(roleRepo.book.get("qa")).toBeUndefined();
    expect(await run(deps, owner(), "role rank testers 1")).toContain("rank 1");
    expect(await run(deps, owner(), "role rank testers 1.5")).toContain("whole number");
    expect(await run(deps, owner(), "role describe testers the people who test")).toContain("Updated");
    expect(roleRepo.book.get("testers")?.description).toBe("the people who test");
    // switched off: the allowlist view drops them until it is on again
    const enforced = enforceRolePolicies(users, roleRepo.book);
    await run(deps, owner(), "role off testers");
    expect(enforced.get("U7")).toBeUndefined();
    await run(deps, owner(), "role on testers");
    expect(enforced.get("U7")?.role).toBe("testers");
    expect(await run(deps, owner(), "role default testers")).toContain("now gets *testers*");
    expect(settings.get("default_role")).toBe("testers");
    expect(await run(deps, owner(), "add <@U9>")).toContain("is now *testers*");
  });

  test("a rename keeps the model override with it", async () => {
    const { deps, settings } = env();
    await run(deps, owner(), "role create qa from pal");
    settings.set("model:qa", "haiku");
    await run(deps, owner(), "role rename qa testers");
    expect(settings.get("model:testers")).toBe("haiku");
    expect(await run(deps, owner(), "model testers")).toContain("`haiku`");
  });
});

describe("add / promote / demote take any role, under the rank rule", () => {
  test("an admin hands out roles below its own, custom ones included, never its own rank or above", async () => {
    const { deps, users } = env();
    await run(deps, owner(), "role create qa from executer");
    await run(deps, owner(), "role create lead from admin");
    expect(await run(deps, admin(), "add <@U7> qa")).toContain("is now *qa*");
    expect(await run(deps, admin(), "add <@U8> executer")).toContain("is now *executer*");
    // same rank as the admin, and the owner role: refused
    expect(await run(deps, admin(), "add <@U9> lead")).toContain("rank below your own");
    expect(await run(deps, admin(), "add <@U9> admin")).toContain("rank below your own");
    expect(await run(deps, admin(), "add <@U9> owner")).toContain("only be one owner");
    expect(users.get("U9")).toBeUndefined();
    // and cannot touch someone who outranks or matches it
    users.upsert({ slackId: "U5", role: "lead", displayName: "L", addedBy: "x", createdAt: 1 });
    expect(await run(deps, admin(), "remove <@U5>")).toContain("outranks");
    expect(await run(deps, admin(), "add <@U5> pal")).toContain("outranks");
    expect(await run(deps, admin(), "add <@U7> nonsense")).toContain("no role called *nonsense*");
  });

  test("promote and demote default to the top and bottom role, or take a named one", async () => {
    const { deps, users } = env();
    await run(deps, owner(), "role create qa from pal");
    await run(deps, owner(), "add <@U1> pal");
    expect(await run(deps, owner(), "promote <@U1>")).toContain("is now *admin*");
    expect(await run(deps, owner(), "demote <@U1>")).toContain("is now *pal*");
    expect(await run(deps, owner(), "promote <@U1> qa")).toContain("is now *qa*");
    expect(await run(deps, owner(), "demote <@U1> executer")).toContain("is now *executer*");
    expect(users.get("U1")?.role).toBe("executer");
    expect(await run(deps, owner(), "promote <@U1> owner")).toContain("only be one owner");
    expect(await run(deps, admin(), "promote <@U1>")).toContain("needs *owner*");
    users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 0 });
    expect(await run(deps, owner(), `promote <@${OWNER}> admin`)).toContain("owner's role cannot be changed");
    void slackCalls;
  });
});
