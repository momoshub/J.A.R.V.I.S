import { Form, useActionData, useLoaderData } from "react-router";
import { get, post, type Identity } from "../api.ts";
import { guard } from "../routes/guard.ts";
import { Banner } from "../ui/feedback.tsx";

export const loader = async () => get<Identity>("identity");

export const action = guard(async ({ request }) => {
  const fd = await request.formData();
  if (fd.get("intent") === "reset") await post("prompt/reset", {});
  else
    await post("identity", {
      name: fd.get("name"),
      thinkingLabel: fd.get("thinkingLabel"),
      thinkingDoneLabel: fd.get("thinkingDoneLabel"),
      prompt: fd.get("prompt"),
    });
  return { ok: true };
});

export function IdentityPage() {
  const id = useLoaderData() as Identity;
  const action = useActionData() as { error?: string; ok?: boolean } | undefined;
  return (
    <>
      <h1>Identity</h1>
      <p className="muted">
        {id.usingDefault ? "Using the built-in default persona." : "Using a custom persona."} Identity, learnings, participants and the addressee are appended automatically.
      </p>
      <Banner error={action?.error} />
      {action?.ok && <div className="banner ok">Saved.</div>}
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="save" />
        <div className="grid2">
          <label>
            <span>bot name</span>
            <input name="name" defaultValue={id.name} required />
          </label>
          <label>
            <span>thinking label (long messages)</span>
            <input name="thinkingLabel" defaultValue={id.thinkingLabel} />
          </label>
          <label>
            <span>thinking done label</span>
            <input name="thinkingDoneLabel" defaultValue={id.thinkingDoneLabel} />
          </label>
        </div>
        <label>
          <span>system prompt - personality &amp; rules</span>
          <textarea name="prompt" defaultValue={id.persona} spellCheck={false} rows={16} />
        </label>
        <div className="row">
          <button type="submit">save</button>
        </div>
      </Form>
      <Form method="post">
        <input type="hidden" name="intent" value="reset" />
        <button className="ghost" type="submit">reset persona to default</button>
      </Form>
    </>
  );
}
