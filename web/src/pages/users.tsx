import { useEffect, useState } from "react";
import { Form, Link, useActionData, useFetcher, useLoaderData } from "react-router";
import { get, post, type AllowedUser, type Bootstrap } from "../api.ts";
import { guard } from "../routes/guard.ts";
import { Banner } from "../ui/feedback.tsx";
import { MemberPicker, type Picked } from "../ui/memberPicker.tsx";

export const loader = async () => {
  const [users, boot] = await Promise.all([get<AllowedUser[]>("users"), get<Bootstrap>("bootstrap")]);
  return { users, owner: boot.ownerSlackId };
};

export const action = guard(async ({ request }) => {
  const fd = await request.formData();
  const intent = fd.get("intent");
  if (intent === "remove") await post("users/remove", { slackId: fd.get("slackId") });
  else if (intent === "update") {
    await post("users/update", {
      slackId: fd.get("slackId"),
      newSlackId: fd.get("newSlackId"),
      displayName: fd.get("displayName"),
      githubLogins: fd.get("githubLogins"),
      // The owner's row has no role picker: leaving it out keeps the role as it is.
      ...(fd.has("role") ? { role: fd.get("role") } : {}),
    });
  } else {
    await post("users", { slackId: fd.get("slackId"), role: fd.get("role"), displayName: fd.get("displayName") ?? "" });
    return { ok: true, added: String(fd.get("slackId") ?? "") };
  }
  return { ok: true };
});

const ROLE_HELP: Record<string, string> = {
  owner: "full control, cannot be removed",
  admin: "full tool access, manages users",
  executer: "sandboxed, tools assigned on Roles",
  pal: "sandboxed read-only tools + review",
};

const ROLES = ["pal", "executer", "admin"] as const;

/**
 * Adding someone: find them in the workspace, pick a role, add. A fetcher, so
 * the form can clear itself once the row lands without a page navigation.
 */
function AddUser() {
  const fetcher = useFetcher<{ ok?: boolean; added?: string; error?: string }>();
  const [picked, setPicked] = useState<Picked | undefined>();
  const [role, setRole] = useState<(typeof ROLES)[number]>("pal");
  const busy = fetcher.state !== "idle";
  const done = fetcher.state === "idle" && fetcher.data?.ok ? fetcher.data.added : undefined;

  useEffect(() => {
    if (done) {
      setPicked(undefined);
      setRole("pal");
    }
  }, [done]);

  const already = picked?.member?.role;
  return (
    <fetcher.Form method="post" className="card add-user">
      <input type="hidden" name="intent" value="add" />
      <input type="hidden" name="slackId" value={picked?.id ?? ""} />
      <input type="hidden" name="displayName" value={picked?.name ?? ""} />
      <input type="hidden" name="role" value={role} />
      <div className="add-user-head">
        <b>Add someone</b>
        <span className="muted">Search the Slack workspace, pick a role, add.</span>
      </div>
      <div className="add-user-row">
        <div className="add-user-who">
          <MemberPicker picked={picked} onPick={setPicked} />
        </div>
        <div className="seg" role="radiogroup" aria-label="role">
          {ROLES.map((r) => (
            <button
              type="button"
              key={r}
              role="radio"
              aria-checked={role === r}
              className={role === r ? "seg-on" : ""}
              onClick={() => setRole(r)}
              title={ROLE_HELP[r]}
            >
              {r}
            </button>
          ))}
        </div>
        <button type="submit" disabled={!picked || busy}>
          {busy ? "adding…" : already ? `make ${role}` : "add"}
        </button>
      </div>
      <div className="add-user-foot muted">
        {already
          ? `${picked?.name} is already on the list as ${already}; adding changes their role.`
          : ROLE_HELP[role]}
      </div>
      {fetcher.data?.error && <div className="banner error">{fetcher.data.error}</div>}
    </fetcher.Form>
  );
}

function UserRow({ u, isOwner }: { u: AllowedUser; isOwner: boolean }) {
  // One form per row; the inputs live in the cells and point at it by id.
  const form = `user-${u.slackId}`;
  return (
    <tr>
      <td>
        <Form method="post" id={form}>
          <input type="hidden" name="intent" value="update" />
          <input type="hidden" name="slackId" value={u.slackId} />
        </Form>
        <input
          form={form}
          name="newSlackId"
          defaultValue={u.slackId}
          pattern="[UW][A-Z0-9]+"
          required
          readOnly={isOwner}
          title={isOwner ? "The owner's id comes from the environment" : "Slack user id"}
        />
      </td>
      <td>
        <input form={form} name="displayName" defaultValue={u.displayName} placeholder={u.name || "unknown"} />
      </td>
      <td>
        <input form={form} name="githubLogins" defaultValue={u.githubLogins.join(", ")} placeholder="github login(s)" spellCheck={false} />
      </td>
      <td>
        {isOwner ? (
          <span className="badge owner">owner</span>
        ) : (
          <select form={form} name="role" defaultValue={u.role}>
            <option value="pal">pal</option>
            <option value="executer">executer</option>
            <option value="admin">admin</option>
          </select>
        )}
        <div className="muted">{ROLE_HELP[u.role]}</div>
      </td>
      <td className="muted">{u.addedBy}</td>
      <td>
        <div className="row" style={{ margin: 0, flexWrap: "nowrap" }}>
          <button form={form} type="submit" className="ghost">save</button>
          {isOwner ? (
            <span className="muted">protected</span>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="remove" />
              <input type="hidden" name="slackId" value={u.slackId} />
              <button className="danger" type="submit">revoke</button>
            </Form>
          )}
        </div>
      </td>
    </tr>
  );
}

export function UsersPage() {
  const { users, owner } = useLoaderData() as { users: AllowedUser[]; owner: string };
  const action = useActionData() as { error?: string } | undefined;
  return (
    <>
      <h1>Users</h1>
      <p className="muted">
        Edit a row and press save. The Slack name is refreshed from Slack when they next write; GitHub logins are the links the
        review inbox and GitHub App use to know who is asking. What each role may do is on <Link to="/roles">Roles</Link>.
      </p>
      <Banner error={action?.error} />
      <AddUser />
      <div className="card table">
        <table>
          <thead>
            <tr><th>slack id</th><th>slack name</th><th>github</th><th>role</th><th>added by</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <UserRow key={u.slackId} u={u} isOwner={u.slackId === owner} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
