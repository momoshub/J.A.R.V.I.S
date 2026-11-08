import { Form, useActionData, useLoaderData } from "react-router";
import { get, post, type AllowedUser, type RoleView, type RolesView } from "../api.ts";
import { guard } from "../routes/guard.ts";
import { Banner } from "../ui/feedback.tsx";

/**
 * Roles - switch each role on or off, take commands, tools and MCP servers away
 * from it, and put people in it. The bot enforces from the same rows, so a
 * save here applies to the next message without a restart. A policy only ever
 * removes: what a role may do at most is still decided in code.
 */
export const loader = async () => {
  const [roles, users] = await Promise.all([get<RolesView>("roles"), get<AllowedUser[]>("users")]);
  return { roles, users };
};

/** Unchecked boxes are what get denied: the form posts what stays allowed. */
const denied = (offered: string[], allowed: FormDataEntryValue[]): string[] => {
  const keep = new Set(allowed.map(String));
  return offered.filter((x) => !keep.has(x));
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
  } else {
    const offered = (name: string) => lines(fd.get(`offered-${name}`));
    await post("roles/policy", {
      role: fd.get("role"),
      enabled: fd.get("enabled") === "on",
      deniedCommands: denied(offered("commands"), fd.getAll("command")),
      deniedTools: [...denied(offered("tools"), fd.getAll("tool")), ...lines(fd.get("extraTools"))],
      deniedMcpServers: [...denied(offered("mcp"), fd.getAll("mcp")), ...lines(fd.get("extraMcp"))],
    });
  }
  return { ok: true };
});

const ROLE_HELP: Record<string, string> = {
  owner: "full control - always on, never restricted",
  admin: "full tool access, manages users",
  executer: "sandboxed: assigned tools, read-only databases, can open PRs",
  pal: "sandboxed read-only tools + review",
};

function Checks({
  name,
  offered,
  items,
  deniedItems,
  disabled,
}: {
  name: string;
  /** Hidden field listing every box shown, so the action can tell unticked from absent. */
  offered: string;
  items: string[];
  deniedItems: string[];
  disabled: boolean;
}) {
  const off = new Set(deniedItems);
  if (items.length === 0) return <p className="muted">Nothing to deny.</p>;
  return (
    <div className="checks">
      <input type="hidden" name={`offered-${offered}`} value={items.join(",")} />
      {items.map((item) => (
        <label className="check" key={item}>
          <input type="checkbox" name={name} value={item} defaultChecked={!off.has(item)} disabled={disabled} />
          <code>{item}</code>
        </label>
      ))}
    </div>
  );
}

function RoleCard({ role, view, users }: { role: RoleView; view: RolesView; users: AllowedUser[] }) {
  const locked = role.locked || !view.editable;
  const extraTools = role.deniedTools.filter((t) => !view.tools.includes(t));
  const extraMcp = role.deniedMcpServers.filter((s) => !view.mcpServers.includes(s));
  const others = users.filter((u) => u.role !== role.role && u.role !== "owner");
  return (
    <div className={`card${role.enabled ? "" : " off"}`}>
      <div className="card-body">
        <div className="role-head">
          <h2 style={{ margin: "12px 0 0" }}>
            <span className={`badge ${role.role}`}>{role.role}</span>{" "}
            {!role.enabled && <span className="pill">switched off</span>}
          </h2>
          <span className="muted">{ROLE_HELP[role.role]}</span>
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
            <input type="hidden" name="role" value={role.role} />
            <select name="slackId" required defaultValue="">
              <option value="" disabled>add someone to {role.role}…</option>
              {others.map((u) => (
                <option key={u.slackId} value={u.slackId}>{`${u.name || "unknown"} (${u.slackId}) - now ${u.role}`}</option>
              ))}
            </select>
            <button type="submit" className="ghost">assign</button>
          </Form>
        )}

        <Form method="post">
          <input type="hidden" name="intent" value="policy" />
          <input type="hidden" name="role" value={role.role} />
          <h3>Status</h3>
          <label className="check">
            <input type="checkbox" name="enabled" defaultChecked={role.enabled} disabled={locked} />
            on - a switched-off role grants nothing: its members are treated as not on the allowlist
          </label>

          <h3>Commands (unticked = denied)</h3>
          <Checks name="command" offered="commands" items={role.commands} deniedItems={role.deniedCommands} disabled={locked} />

          <h3>Tools (unticked = denied)</h3>
          <Checks name="tool" offered="tools" items={view.tools} deniedItems={role.deniedTools} disabled={locked} />
          {!locked && (
            <label style={{ marginTop: 8 }}>
              <span>Other denied tool patterns, one per line - e.g. <code>Bash(rm:*)</code></span>
              <textarea name="extraTools" rows={2} spellCheck={false} defaultValue={extraTools.join("\n")} />
            </label>
          )}

          <h3>MCP servers (unticked = denied)</h3>
          <Checks name="mcp" offered="mcp" items={view.mcpServers} deniedItems={role.deniedMcpServers} disabled={locked} />
          {!locked && (
            <label style={{ marginTop: 8 }}>
              <span>Other MCP servers to deny, one per line</span>
              <textarea name="extraMcp" rows={2} spellCheck={false} defaultValue={extraMcp.join("\n")} />
            </label>
          )}

          {locked ? (
            <p className="muted">
              {role.locked ? "The owner role cannot be switched off or restricted." : "Role policies are not wired up on this instance."}
            </p>
          ) : (
            <div className="row"><button type="submit">save {role.role}</button></div>
          )}
        </Form>
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
        Roles rank <code>pal</code> &lt; <code>executer</code> &lt; <code>admin</code> &lt; <code>owner</code>, and what each may
        do at most is fixed in code. Here you can only take away: switch a role off, or untick what it may not use. Commands above a
        role's rank are not listed for it. Saves apply to the next message - no restart.
      </p>
      <Banner error={action?.error} />
      {roles.roles.map((r) => (
        <RoleCard key={r.role} role={r} view={roles} users={users} />
      ))}

      <h2>Executer tools</h2>
      <p className="muted">
        Tools the <span className="badge executer">executer</span> role is pre-approved for (one per line or comma-separated).
        Blank falls back to the read-only pal set. e.g. <code>Read</code>, <code>WebSearch</code>, <code>Bash(gh pr view:*)</code>.
      </p>
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="executerTools" />
        <textarea name="executerTools" defaultValue={roles.executerTools} rows={6} spellCheck={false} />
        <div className="row"><button type="submit">save executer tools</button></div>
      </Form>
    </>
  );
}
