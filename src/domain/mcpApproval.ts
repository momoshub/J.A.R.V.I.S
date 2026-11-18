/**
 * Discovery is not exposure: a tool an MCP server starts listing after the
 * owner last looked stays hidden and uncallable until the owner approves it.
 *
 * Per server the lazy proxy keeps an `ApprovalState`. The first run of a server
 * has no state, and its current tools become the baseline (`approved`), so an
 * existing setup breaks nothing. From then on a listed tool is exposed only when
 * it is approved; one the owner turned down sits in `denied` and stays out of the
 * `pending` list. Keyed by tool NAME: a changed description or schema needs no
 * new approval, and a tool the server drops simply disappears.
 */

export type ApprovalState = {
  readonly approved: readonly string[];
  readonly denied: readonly string[];
};

/** The tool name inside an MCP `tools/list` item, if it has one. */
export const toolNameOf = (tool: unknown): string | undefined => {
  if (!tool || typeof tool !== "object") return undefined;
  const name = (tool as { name?: unknown }).name;
  return typeof name === "string" && name ? name : undefined;
};

export const namesOf = (tools: readonly unknown[]): string[] => tools.flatMap((t) => toolNameOf(t) ?? []);

const unique = (names: readonly string[]): string[] => [...new Set(names)].sort();

/** The first run of a server: whatever it lists now is what the owner already lives with. */
export const baselineOf = (tools: readonly unknown[]): ApprovalState => ({ approved: unique(namesOf(tools)), denied: [] });

export const isApproved = (state: ApprovalState, name: string): boolean => state.approved.includes(name);

/** Tools the server lists that the owner has neither approved nor denied. */
export const pendingOf = (state: ApprovalState, tools: readonly unknown[]): string[] =>
  unique(namesOf(tools).filter((n) => !state.approved.includes(n) && !state.denied.includes(n)));

export const approveTool = (state: ApprovalState, name: string): ApprovalState => ({
  approved: unique([...state.approved, name]),
  denied: state.denied.filter((n) => n !== name),
});

/** Also revokes an approved tool: it is hidden again at once. */
export const denyTool = (state: ApprovalState, name: string): ApprovalState => ({
  approved: state.approved.filter((n) => n !== name),
  denied: unique([...state.denied, name]),
});

/** What `tools/list` may show: approved tools only. */
export const exposedTools = (state: ApprovalState, tools: readonly unknown[]): unknown[] =>
  tools.filter((t) => {
    const name = toolNameOf(t);
    return name !== undefined && isApproved(state, name);
  });

/** Reads a stored state; anything malformed is an empty one, so a damaged file hides tools instead of exposing them. */
export const parseApprovalState = (raw: unknown): ApprovalState => {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { approved: unique(list(o.approved)), denied: unique(list(o.denied)) };
};

/** What the model sees when it calls a tool that is not approved (returned as a tool error, so it can say so). */
export const awaitingApprovalMessage = (server: string, tool: string): string =>
  `The tool \`${tool}\` of the MCP server \`${server}\` is new and has not been approved by the owner yet, so it cannot be called. Tell the owner to run \`mcp-tools approve ${server} ${tool}\`.`;
