import { Form, useLoaderData } from "react-router-dom";
import { fmtTime, type CommandInfo, type CommandLogEntry } from "./api.ts";

type Data = { commands: CommandInfo[]; disabled: string[]; log: CommandLogEntry[] };

/**
 * Commands - manage the registry (enable/disable) and browse the execution log.
 */
export function CommandsPage() {
  const { commands, disabled, log } = useLoaderData() as Data;
  const off = new Set(disabled);

  return (
    <>
      <h1>Commands</h1>
      <p className="muted">
        Every command runs two ways: <code>/ev &lt;name&gt;</code> (slash) or <code>//ev &lt;name&gt;</code> (message).
        Disable one to turn it off for everyone (except <code>help</code>).
      </p>

      <div className="card table">
        <table>
          <thead>
            <tr><th>command</th><th>usage</th><th>role</th><th>status</th><th /></tr>
          </thead>
          <tbody>
            {commands.map((c) => {
              const disabledNow = off.has(c.name);
              return (
                <tr key={c.name}>
                  <td>
                    <code>{c.name}</code>
                    {c.aliases.length > 0 && <span className="muted"> · {c.aliases.join(", ")}</span>}
                    <div className="muted">{c.summary}</div>
                  </td>
                  <td className="muted">{c.usage || "-"}</td>
                  <td><span className={`badge ${c.minRole}`}>{c.minRole}</span></td>
                  <td>
                    {disabledNow ? <span className="badge member">disabled</span> : <span className="badge admin">enabled</span>}
                  </td>
                  <td>
                    {c.name === "help" ? (
                      <span className="muted">always on</span>
                    ) : (
                      <Form method="post">
                        <input type="hidden" name="intent" value="toggle" />
                        <input type="hidden" name="name" value={c.name} />
                        <input type="hidden" name="enabled" value={disabledNow ? "true" : "false"} />
                        <button className={disabledNow ? "" : "ghost"} type="submit">
                          {disabledNow ? "enable" : "disable"}
                        </button>
                      </Form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2>History</h2>
        {log.length > 0 && (
          <Form method="post">
            <input type="hidden" name="intent" value="clear" />
            <button className="danger" type="submit">clear history</button>
          </Form>
        )}
      </div>
      <div className="card table">
        <table>
          <thead>
            <tr><th>when</th><th>who</th><th>command</th><th>args</th><th>ok</th></tr>
          </thead>
          <tbody>
            {log.length === 0 && <tr><td colSpan={5} className="muted">No commands run yet.</td></tr>}
            {log.map((e) => (
              <tr key={e.id}>
                <td className="muted">{fmtTime(e.createdAt)}</td>
                <td><code>{e.slackUserId}</code></td>
                <td><code>{e.command}</code></td>
                <td className="muted">{e.args || "-"}</td>
                <td>{e.ok ? "✅" : <span className="badge member" title={e.result}>failed</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
