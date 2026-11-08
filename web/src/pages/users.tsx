import { Form, useActionData, useLoaderData } from "react-router";
import { get, post, type AllowedUser, type Bootstrap } from "../api.ts";
import { guard } from "../routes/guard.ts";
import { Banner } from "../ui/feedback.tsx";

export const loader = async () => {
  const [users, boot, roles] = await Promise.all([
    get<AllowedUser[]>("users"),
    get<Bootstrap>("bootstrap"),
    get<{ executerTools: string }>("roles"),
  ]);
  return { users, owner: boot.ownerSlackId, executerTools: roles.executerTools };
};

export const action = guard(async ({ request }) => {
  const fd = await request.formData();
  const intent = fd.get("intent");
  if (intent === "remove") await post("users/remove", { slackId: fd.get("slackId") });
  else if (intent === "executerTools") await post("roles", { executerTools: fd.get("executerTools") });
  else await post("users", { slackId: fd.get("slackId"), role: fd.get("role") });
  return { ok: true };
});

const ROLE_HELP: Record<string, string> = {
  owner: "full control, cannot be removed",
  admin: "full tool access, manages users",
  executer: "sandboxed, tools assigned below",
  pal: "sandboxed read-only tools + review",
};

export function UsersPage() {
  const { users, owner, executerTools } = useLoaderData() as {
    users: AllowedUser[];
    owner: string;
    executerTools: string;
  };
  const action = useActionData() as { error?: string } | undefined;
  return (
    <>
      <h1>Users</h1>
      <Banner error={action?.error} />
      <Form method="post" className="row">
        <input type="hidden" name="intent" value="add" />
        <input name="slackId" placeholder="U0123456789" pattern="[UW][A-Z0-9]+" required />
        <select name="role" defaultValue="pal">
          <option value="pal">pal</option>
          <option value="executer">executer</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit">add / update</button>
      </Form>
      <div className="card table">
        <table>
          <thead>
            <tr><th>user</th><th>role</th><th>added by</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.slackId}>
                <td>
                  <code>{`<@${u.slackId}:${u.name || "?"}>`}</code>
                </td>
                <td>
                  <span className={`badge ${u.role}`}>{u.role}</span>
                  <div className="muted">{ROLE_HELP[u.role]}</div>
                </td>
                <td className="muted">{u.addedBy}</td>
                <td>
                  {u.slackId === owner ? (
                    <span className="muted">protected</span>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove" />
                      <input type="hidden" name="slackId" value={u.slackId} />
                      <button className="danger" type="submit">revoke</button>
                    </Form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Executer tools</h2>
      <p className="muted">Tools the <span className="badge executer">executer</span> role may use (one per line or comma-separated). Blank falls back to the read-only pal set. e.g. <code>Read</code>, <code>WebSearch</code>, <code>Bash(gh pr view:*)</code>.</p>
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="executerTools" />
        <textarea name="executerTools" defaultValue={executerTools} rows={6} spellCheck={false} />
        <div className="row"><button type="submit">save executer tools</button></div>
      </Form>
    </>
  );
}
