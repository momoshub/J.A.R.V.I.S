import { Form, useActionData, useLoaderData } from "react-router";
import { get, post, type AllowedUser, type PermissionInfo, type RoleView, type RolesView } from "../api.ts";
import { guard } from "../routes/guard.ts";
import { Banner } from "../ui/feedback.tsx";

/**
 * Roles - the owner's page. Only the owner role is fixed (always on, holds every permission, cannot
 * be restricted or deleted); every other role is data: a name, a rank, and the permissions it GRANTS.
 * Tick what a role may do - each command, each GitHub App action, tool tiers, MCP servers - create
 * your own, rename or delete one (refused while people hold it), and put people in a role. The bot
 * enforces from the same rows, so a save applies to the next message without a restart.
 */
export const loader = async () => {
  const [roles, users] = await Promise.all([get<RolesView>("roles"), get<AllowedUser[]>("users")]);
  return { roles, users };
};

const lines = (v: FormDataEntryValue | null): string[] =>
  String(v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

export const action = guard(async ({ request }) => {
  const fd = await request.formData();
  const intent = fd.get("intent");
  if (intent === "assign") {
    await post("roles/assign", { slackId: fd.get("slackId"), role: fd.get("role") });
  } else if (intent === "executerTools") {
    await post("roles", { executerTools: fd.get("executerTools") });
  } else if (intent === "create") {
    await post("roles/save", {
      name: fd.get("name"),
      from: fd.get("from"),
      create: true,
      description: fd.get("description"),
      rank: fd.get("rank") ?? "",
      enabled: true,
    });
  } else if (intent === "delete") {
    await post("roles/delete", { name: fd.get("name") });
  } else if (intent === "rename") {
    await post("roles/rename", { from: fd.get("name"), to: fd.get("to") });
  } else if (intent === "default") {
    await post("roles/default", { name: fd.get("name") });
  } else if (intent === "mcpServer") {
    await post("roles/mcp-server", { server: fd.get("server") });
  } else {
    await post("roles/save", {
      name: fd.get("name"),
      rank: fd.get("rank"),
      description: fd.get("description"),
      enabled: fd.get("enabled") === "on",
      grants: fd.getAll("grant").map(String),
      deniedTools: lines(fd.get("deniedTools")),
    });
  }
  return { ok: true };
});

function Grants({ role, catalogue, disabled }: { role: RoleView; catalogue: PermissionInfo[]; disabled: boolean }) {
  const held = new Set(role.grants);
  const groups = [...new Set(catalogue.map((p) => p.group))];
  // A permission that no longer exists (a removed command) stays tickable until it is unticked.
  const stale = role.grants.filter((g) => !catalogue.some((p) => p.id === g));
  return (
    <>
      {groups.map((group) => {
        const items = catalogue.filter((p) => p.group === group);
        const on = items.filter((p) => held.has(p.id)).length;
        return (
          <details key={group} open={group !== "Commands"}>
            <summary>
              <b>{group}</b> <span className="muted">{on} of {items.length} granted</span>
            </summary>
            <div className="checks">
              {items.map((p) => (
                <label className="check" key={p.id} title={p.label}>
                  <input type="checkbox" name="grant" value={p.id} defaultChecked={held.has(p.id)} disabled={disabled} />
                  <code>{group === "Commands" ? p.id.replace(/^command:/, "") : p.id}</code>
                </label>
              ))}
            </div>
          </details>
        );
      })}
      {stale.length > 0 && (
        <details>
          <summary>
            <b>No longer offered</b> <span className="muted">{stale.length} held</span>
          </summary>
          <div className="checks">
            {stale.map((id) => (
              <label className="check" key={id}>
                <input type="checkbox" name="grant" value={id} defaultChecked disabled={disabled} />
                <code>{id}</code>
              </label>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function RoleCard({ role, view, users }: { role: RoleView; view: RolesView; users: AllowedUser[] }) {
  const locked = role.locked || !view.editable;
  const others = users.filter((u) => u.role !== role.name && u.role !== "owner");
  const isDefault = view.defaultRole === role.name;
  return (
    <div className={`card${role.enabled ? "" : " off"}`}>
      <div className="card-body">
        <div className="role-head">
          <h2 style={{ margin: "12px 0 0" }}>
            <span className={`badge ${role.name}`}>{role.name}</span>{" "}
            {role.seed && <span className="pill">built in</span>} {isDefault && <span className="pill">default</span>}{" "}
            {!role.enabled && <span className="pill">switched off</span>}
          </h2>
          <span className="muted">{role.description || (role.locked ? "full control - always on, holds everything" : "")}</span>
        </div>

        <h3>Members</h3>
        <div className="members">
          {role.members.length === 0 && <span className="muted">Nobody.</span>}
          {role.members.map((m) => (
            <span className="pill" key={m.slackId}>{`${m.name || "unknown"} (${m.slackId})`}</span>
          ))}
        </div>
        {!role.locked && others.length > 0 && (
          <Form method="post" className="row">
            <input type="hidden" name="intent" value="assign" />
            <input type="hidden" name="role" value={role.name} />
            <select name="slackId" required defaultValue="">
              <option value="" disabled>add someone to {role.name}…</option>
              {others.map((u) => (
                <option key={u.slackId} value={u.slackId}>{`${u.name || "unknown"} (${u.slackId}) - now ${u.role}`}</option>
              ))}
            </select>
            <button type="submit" className="ghost">assign</button>
          </Form>
        )}

        {role.locked ? (
          <p className="muted">
            The owner role cannot be switched off, restricted, renamed or deleted, and managing roles is its alone: no other role can be granted it.
          </p>
        ) : (
          <>
            <Form method="post">
              <input type="hidden" name="intent" value="policy" />
              <input type="hidden" name="name" value={role.name} />
              <h3>Role</h3>
              <div className="row">
                <label>
                  <span>Rank - higher outranks lower; a role only manages people below its own</span>
                  <input name="rank" type="number" min={0} max={10000} defaultValue={role.rank ?? 0} disabled={locked} />
                </label>
                <label style={{ flex: 1 }}>
                  <span>Description</span>
                  <input name="description" defaultValue={role.description} disabled={locked} />
                </label>
              </div>
              <label className="check">
                <input type="checkbox" name="enabled" defaultChecked={role.enabled} disabled={locked} />
                on - a switched-off role grants nothing: its members are treated as not on the allowlist
              </label>

              <h3>Grants</h3>
              <p className="muted">
                What this role may do. A role with <code>tools:full-access</code> runs chat turns with any tool; without it the sandbox
                applies (<code>tools:code</code> adds code edits, commits and PRs). Servers it holds no <code>mcp:</code> grant for
                are denied by name.
              </p>
              <Grants role={role} catalogue={view.catalogue} disabled={locked} />

              <h3>Extra denied tools</h3>
              <label>
                <span>CLI tool patterns this role is refused whatever it is granted, one per line - e.g. <code>Bash(rm:*)</code></span>
                <textarea name="deniedTools" rows={2} spellCheck={false} defaultValue={role.deniedTools.join("\n")} disabled={locked} />
              </label>
              <div className="row"><button type="submit" disabled={locked}>save {role.name}</button></div>
            </Form>

            <div className="row">
              <Form method="post" className="row">
                <input type="hidden" name="intent" value="rename" />
                <input type="hidden" name="name" value={role.name} />
                <input name="to" placeholder="new name" required style={{ width: 140 }} />
                <button type="submit" className="ghost">rename</button>
              </Form>
              {!isDefault && (
                <Form method="post">
                  <input type="hidden" name="intent" value="default" />
                  <input type="hidden" name="name" value={role.name} />
                  <button type="submit" className="ghost" title="the role an approved access request gets">make default</button>
                </Form>
              )}
              <Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="name" value={role.name} />
                <button type="submit" className="danger" disabled={role.members.length > 0} title={role.members.length > 0 ? "move its members first" : ""}>
                  delete
                </button>
              </Form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function RolesPage() {
  const { roles, users } = useLoaderData() as { roles: RolesView; users: AllowedUser[] };
  const action = useActionData() as { error?: string } | undefined;
  return (
    <>
      <h1>Roles</h1>
      <p className="muted">
        Only <code>owner</code> is fixed in code. Every other role is data: tick the permissions it grants, create your own, and put
        people in it. <code>pal</code>, <code>executer</code> and <code>admin</code> are just the roles this instance started with, with
        the grants the code used to hard-wire. Saves apply to the next message - no restart.
      </p>
      <Banner error={action?.error} />

      {roles.editable && (
        <div className="card">
          <div className="card-body">
            <h2 style={{ marginTop: 0 }}>New role</h2>
            <Form method="post" className="row">
              <input type="hidden" name="intent" value="create" />
              <input name="name" placeholder="name, e.g. qa" required pattern="[a-z][a-z0-9_-]{0,31}" style={{ width: 160 }} />
              <select name="from" defaultValue="">
                <option value="">start with nothing</option>
                {roles.roles.filter((r) => !r.locked).map((r) => (
                  <option key={r.name} value={r.name}>copy from {r.name}</option>
                ))}
              </select>
              <input name="rank" type="number" min={0} max={10000} placeholder="rank" style={{ width: 90 }} />
              <input name="description" placeholder="description" style={{ flex: 1, minWidth: 160 }} />
              <button type="submit">create</button>
            </Form>
          </div>
        </div>
      )}

      {roles.roles.map((r) => (
        <RoleCard key={r.name} role={r} view={roles} users={users} />
      ))}

      <h2>MCP servers</h2>
      <p className="muted">
        Servers a role can be granted: {roles.mcpServers.map((s) => <code key={s}>{s} </code>)}. Name one the host runs that is not
        listed (it is then denied to every role without the grant).
      </p>
      <Form method="post" className="row">
        <input type="hidden" name="intent" value="mcpServer" />
        <input name="server" placeholder="server name as in ~/.claude.json" required />
        <button type="submit" className="ghost">add server</button>
      </Form>

      <h2>Code-tier tools</h2>
      <p className="muted">
        Tools every role holding <code>tools:code</code> (the executer, as seeded) is pre-approved for, one per line or comma-separated.
        Blank falls back to the read-only set. e.g. <code>Read</code>, <code>WebSearch</code>, <code>Bash(gh pr view:*)</code>.
      </p>
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="executerTools" />
        <textarea name="executerTools" defaultValue={roles.executerTools} rows={6} spellCheck={false} />
        <div className="row"><button type="submit">save code-tier tools</button></div>
      </Form>
    </>
  );
}
