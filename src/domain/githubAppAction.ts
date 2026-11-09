/**
 * GitHub App actions - what a turn may ask the app to do on GitHub, as pure
 * data. Nothing here talks to GitHub: `planAction` validates one request and
 * turns it into the REST calls that carry it out, `mayActAsApp` is the role
 * gate. The app's identity is stronger than any one person's (it can be
 * installed on orgs the caller has no access to), so acting as it is an admin
 * thing and the gate lives next to the actions, not scattered.
 */
import type { UserRole } from "./types.ts";

export const ACTIONS = [
  "pr-create",
  "comment",
  "review",
  "pr-edit",
  "pr-close",
  "pr-reopen",
  "pr-merge",
  "labels-add",
  "labels-remove",
  "reviewers-request",
] as const;
export type ActionName = (typeof ACTIONS)[number];

export const REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;

/** Admin and owner may act as the app; everybody else may not. */
export const mayActAsApp = (role: UserRole): boolean => role === "admin" || role === "owner";

export const DENIED_MESSAGE =
  "acting on GitHub as the app needs the admin role - ask an admin (or the owner) to do this, or use your own token";

/** One REST call. */
export type GithubCall = { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; path: string; body?: unknown };

export type ActionRequest = {
  action?: unknown;
  repo?: unknown;
  number?: unknown;
  head?: unknown;
  base?: unknown;
  title?: unknown;
  body?: unknown;
  draft?: unknown;
  event?: unknown;
  method?: unknown;
  labels?: unknown;
  reviewers?: unknown;
};

export type Plan = { ok: true; action: ActionName; repo: string; calls: GithubCall[] } | { ok: false; error: string };

const REPO = /^[\w.-]+\/[\w.-]+$/;
/** `.` and `..` match the pattern above but are path steps, not names. */
const isRepoName = (repo: string): boolean => REPO.test(repo) && repo.split("/").every((s) => !/^\.+$/.test(s));
const REF = /^[^\s~^:?*[\\]+$/;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim()) ? (v as string[]).map((x) => x.trim()) : undefined;

const fail = (error: string): Plan => ({ ok: false, error });

export const isActionName = (v: unknown): v is ActionName => (ACTIONS as readonly unknown[]).includes(v);

export const planAction = (req: ActionRequest): Plan => {
  const action = req.action;
  if (!isActionName(action)) return fail(`unknown action ${JSON.stringify(action)}; one of ${ACTIONS.join(", ")}`);
  const repo = str(req.repo).trim();
  if (!isRepoName(repo)) return fail("repo must look like owner/name");
  const done = (calls: GithubCall[]): Plan => ({ ok: true, action, repo, calls });

  if (action === "pr-create") {
    const head = str(req.head).trim();
    const base = str(req.base).trim();
    const title = str(req.title).trim();
    if (!head || !base || !title) return fail("pr-create needs head, base and title");
    if (!REF.test(head.replace(/^[\w.-]+:/, "")) || !REF.test(base)) return fail("head and base must be branch names");
    return done([
      {
        method: "POST",
        path: `repos/${repo}/pulls`,
        body: { title, head, base, body: str(req.body), draft: req.draft === true },
      },
    ]);
  }

  const number = Number(req.number);
  if (!Number.isInteger(number) || number <= 0) return fail(`${action} needs a positive number`);
  const pull = `repos/${repo}/pulls/${number}`;
  const issue = `repos/${repo}/issues/${number}`;
  const text = str(req.body);

  switch (action) {
    case "comment":
      if (!text.trim()) return fail("comment needs a non-empty body");
      return done([{ method: "POST", path: `${issue}/comments`, body: { body: text } }]);
    case "review": {
      const event = str(req.event).toUpperCase();
      if (!(REVIEW_EVENTS as readonly string[]).includes(event)) {
        return fail(`review event must be ${REVIEW_EVENTS.join(", ")}`);
      }
      if (event !== "APPROVE" && !text.trim()) return fail(`a ${event} review needs a body`);
      return done([{ method: "POST", path: `${pull}/reviews`, body: { event, ...(text.trim() ? { body: text } : {}) } }]);
    }
    case "pr-edit": {
      const title = str(req.title).trim();
      const patch: Record<string, string> = {};
      if (title) patch.title = title;
      if (req.body !== undefined) patch.body = text;
      if (Object.keys(patch).length === 0) return fail("pr-edit needs a title or a body");
      return done([{ method: "PATCH", path: pull, body: patch }]);
    }
    case "pr-close":
      return done([{ method: "PATCH", path: pull, body: { state: "closed" } }]);
    case "pr-reopen":
      return done([{ method: "PATCH", path: pull, body: { state: "open" } }]);
    case "pr-merge": {
      const method = str(req.method).trim() || "merge";
      if (!(MERGE_METHODS as readonly string[]).includes(method)) return fail(`merge method must be ${MERGE_METHODS.join(", ")}`);
      return done([{ method: "PUT", path: `${pull}/merge`, body: { merge_method: method } }]);
    }
    case "labels-add": {
      const labels = strList(req.labels);
      if (!labels?.length) return fail("labels-add needs at least one label");
      return done([{ method: "POST", path: `${issue}/labels`, body: { labels } }]);
    }
    case "labels-remove": {
      const labels = strList(req.labels);
      if (!labels?.length) return fail("labels-remove needs at least one label");
      return done(labels.map((l) => ({ method: "DELETE" as const, path: `${issue}/labels/${encodeURIComponent(l)}` })));
    }
    case "reviewers-request": {
      const who = strList(req.reviewers);
      if (!who?.length) return fail("reviewers-request needs at least one reviewer");
      const teams = who.filter((w) => w.startsWith("team:")).map((w) => w.slice(5));
      const users = who.filter((w) => !w.startsWith("team:"));
      return done([
        {
          method: "POST",
          path: `${pull}/requested_reviewers`,
          body: { ...(users.length ? { reviewers: users } : {}), ...(teams.length ? { team_reviewers: teams } : {}) },
        },
      ]);
    }
  }
};

/** The url and number GitHub's answer carries, for the caller. */
export const summarize = (out: unknown): { url?: string; number?: number } => {
  const o = out && typeof out === "object" ? (out as Record<string, unknown>) : {};
  return {
    ...(typeof o.html_url === "string" ? { url: o.html_url } : {}),
    ...(typeof o.number === "number" ? { number: o.number } : {}),
  };
};
