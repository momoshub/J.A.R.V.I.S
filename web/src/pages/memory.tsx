import { Form, useActionData, useLoaderData } from "react-router";
import { fmtTime, get, post, type AdapterFile, type AdapterView, type Learning } from "../api.ts";
import { guard } from "../routes/guard.ts";
import { Banner } from "../ui/feedback.tsx";

export const loader = async () => {
  const [learnings, adapter] = await Promise.all([get<Learning[]>("learnings"), get<AdapterView>("adapter")]);
  const files = adapter.configured ? await get<AdapterFile[]>("adapter/files") : [];
  return { learnings, adapter, files };
};

export const action = guard(async ({ request }) => {
  const fd = await request.formData();
  const intent = fd.get("intent");
  if (intent === "edit") {
    const path = String(fd.get("path") ?? "");
    const content = String(fd.get("content") ?? "");
    // A refused save reloads the page and rebuilds the editor from
    // what is stored, so the text typed is handed back to be copied.
    return post<{ ok: true; warnings: string[] }>("adapter/file", {
      path,
      content,
      base: String(fd.get("base") ?? ""),
    }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e), unsaved: { path, content } }));
  }
  if (intent === "revert") await post("adapter/revert", { id: Number(fd.get("id")) });
  else if (intent === "remove") await post("learnings/remove", { id: Number(fd.get("id")) });
  else if (intent === "update")
    await post("learnings/update", { id: Number(fd.get("id")), content: fd.get("content") });
  // `learnings` is the teach endpoint either way: with an adapter it
  // writes there instead of the table.
  else await post("learnings", { content: fd.get("content") });
  return { ok: true };
});

/**
 * Memory, when it is an adapter.
 *
 * Teach one fact, edit a whole file by hand, or put a revision back. A hand
 * edit is one file at a time through the same gate as `adapter refine`, and
 * every save is a revision - not the old grid of text boxes writing straight
 * into a list nothing checked, which is how that list came to hold a fact and
 * its own retraction at the same time.
 */
function AdapterMemory({
  a,
  files,
  error,
  warnings,
  unsaved,
}: {
  a: AdapterView;
  files: AdapterFile[];
  error?: string;
  warnings?: string[];
  unsaved?: { path: string; content: string };
}) {
  return (
    <>
      <h1>Memory</h1>
      <p className="muted">
        A Hermit harness adapter. The policy and notes load into every reply; notes about a person or a
        channel load only there, and a skill costs its description until something makes it relevant.
      </p>
      <Banner error={error} />
      {a.status && <pre className="card">{a.status}</pre>}

      <Form method="post" className="row">
        <input type="hidden" name="intent" value="add" />
        <input name="content" placeholder="teach one durable fact" required style={{ flex: 1 }} />
        <button type="submit">teach</button>
      </Form>
      <p className="muted">
        It lands under "Recently taught" and stays there until a refine pass files it. Run that with
        <code> adapter refine</code> in Slack.
      </p>

      <h2>Edit by hand</h2>
      <p className="muted">
        One file per save, checked by the same gate as refine and kept as a revision. Blank a file to remove it.
      </p>
      {(warnings ?? []).length > 0 && <pre className="card">{(warnings ?? []).join("\n")}</pre>}
      {unsaved && (
        <>
          <p className="muted">Not saved - your text for <code>{unsaved.path}</code>, to copy back in:</p>
          <pre className="card">{unsaved.content}</pre>
        </>
      )}
      {files.map((f) => (
        <details key={f.path} className="card">
          <summary><code>{f.path}</code></summary>
          <Form method="post">
            <input type="hidden" name="intent" value="edit" />
            <input type="hidden" name="path" value={f.path} />
            {/* What this editor was opened on: the save is refused if the file moved since. */}
            <input type="hidden" name="base" value={f.content} />
            {/* Keyed on the content so a save or revert shows what is now stored. */}
            <textarea key={f.content} name="content" defaultValue={f.content} rows={Math.min(30, f.content.split("\n").length + 2)} spellCheck={false} style={{ width: "100%" }} />
            <div className="row"><button type="submit">save {f.path}</button></div>
          </Form>
        </details>
      ))}
      <details className="card">
        <summary>new file</summary>
        <Form method="post">
          <input type="hidden" name="intent" value="edit" />
          <input name="path" placeholder="memory/people/U123.md" required style={{ width: "100%" }} />
          {/* A new file must not exist yet. */}
          <input type="hidden" name="base" value="" />
          <textarea name="content" rows={6} required spellCheck={false} style={{ width: "100%" }} />
          <div className="row"><button type="submit">create</button></div>
        </Form>
      </details>

      <h2>Policy</h2>
      <p className="muted">Rules. Always loaded.</p>
      <pre className="card">{a.policy?.trim() || "Nothing yet."}</pre>

      <h2>Notes</h2>
      <p className="muted">Facts. Always loaded.</p>
      <pre className="card">{a.notes?.trim() || "Nothing yet."}</pre>

      <h2>In depth</h2>
      <p className="muted">Only the description is loaded; the body is read when it is relevant.</p>
      <div className="card table">
        <table>
          <thead><tr><th>skill</th><th>description</th></tr></thead>
          <tbody>
            {(a.skills ?? []).length === 0 && <tr><td colSpan={2} className="muted">No skills yet.</td></tr>}
            {(a.skills ?? []).map((s) => (
              <tr key={s.name}><td>{s.name}</td><td className="muted">{s.description}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Scoped</h2>
      <p className="muted">Loaded only when that person is in the conversation, or in that channel.</p>
      <p>
        {(a.people ?? []).length + (a.channels ?? []).length === 0
          ? <span className="muted">Nothing scoped yet.</span>
          : [...(a.people ?? []), ...(a.channels ?? [])].map((id) => <code key={id} style={{ marginRight: 8 }}>{id}</code>)}
      </p>

      <h2>Revisions</h2>
      <p className="muted">Every change is a snapshot, so a curation that lost something is one click back.</p>
      <div className="card table">
        <table>
          <thead><tr><th>#</th><th>what</th><th>by</th><th>when</th><th /></tr></thead>
          <tbody>
            {(a.revisions ?? []).length === 0 && <tr><td colSpan={5} className="muted">No revisions yet.</td></tr>}
            {(a.revisions ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.reason}</td>
                <td className="muted">{r.createdBy}</td>
                <td className="muted">{fmtTime(r.createdAt)}</td>
                <td>
                  <Form method="post">
                    <input type="hidden" name="intent" value="revert" />
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit">revert</button>
                  </Form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The flat list, for an instance that has not moved to an adapter. */
function LegacyLearnings({ learnings, error }: { learnings: Learning[]; error?: string }) {
  return (
    <>
      <h1>Learnings</h1>
      <p className="muted">Durable facts injected into every reply as known facts.</p>
      <Banner error={error} />
      <Form method="post" className="row">
        <input type="hidden" name="intent" value="add" />
        <input name="content" placeholder="e.g. Our staging URL is staging.example.com" required style={{ flex: 1 }} />
        <button type="submit">add learning</button>
      </Form>
      <div className="card table">
        <table>
          <thead><tr><th>learning</th><th>by</th><th>when</th><th /></tr></thead>
          <tbody>
            {learnings.length === 0 && (
              <tr><td colSpan={4} className="muted">Nothing learned yet.</td></tr>
            )}
            {learnings.map((l) => (
              <tr key={l.id}>
                <td>
                  {/* Edit in place: the row is the field, so rewording is one
                      click and a save rather than delete-and-retype. */}
                  <Form method="post" className="row" id={`learning-${l.id}`}>
                    <input type="hidden" name="intent" value="update" />
                    <input type="hidden" name="id" value={l.id} />
                    <input name="content" defaultValue={l.content} required style={{ flex: 1 }} />
                  </Form>
                </td>
                <td className="muted">{l.createdBy}</td>
                <td className="muted">{fmtTime(l.createdAt)}</td>
                <td className="row">
                  <button type="submit" form={`learning-${l.id}`}>save</button>
                  <Form method="post">
                    <input type="hidden" name="intent" value="remove" />
                    <input type="hidden" name="id" value={l.id} />
                    <button className="danger" type="submit">delete</button>
                  </Form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function LearningsPage() {
  const { learnings, adapter, files } = useLoaderData() as {
    learnings: Learning[];
    adapter: AdapterView;
    files: AdapterFile[];
  };
  const action = useActionData() as
    | { error?: string; warnings?: string[]; unsaved?: { path: string; content: string } }
    | undefined;
  return adapter.configured
    ? <AdapterMemory a={adapter} files={files} error={action?.error} warnings={action?.warnings} unsaved={action?.unsaved} />
    : <LegacyLearnings learnings={learnings} error={action?.error} />;
}
