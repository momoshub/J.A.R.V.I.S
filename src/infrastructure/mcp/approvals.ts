import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  approveTool,
  baselineOf,
  denyTool,
  namesOf,
  parseApprovalState,
  pendingOf,
  type ApprovalState,
} from "../../domain/mcpApproval.ts";

/**
 * Tool approvals live in a file next to the schema cache, not in the bot's
 * database: the lazy proxy is a separate process started by the CLI with no
 * config of its own, and the cache directory is the one thing it is handed. One
 * file per server NAME (not per launch line, unlike the cache), so editing a
 * server's command does not hand it a fresh baseline.
 */

export type ApprovalStore = {
  /** Undefined when the server has never been baselined. */
  read: () => ApprovalState | undefined;
  /** Writes the state only if there is none yet; false when another process got there first. */
  create: (state: ApprovalState) => boolean;
  write: (state: ApprovalState) => void;
};

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_.-]/g, "_");

export const approvalsPath = (cacheDir: string, server: string): string => join(cacheDir, "approvals", `${safeName(server)}.json`);

export const createFileApprovalStore = (path: string): ApprovalStore => {
  const dir = join(path, "..");
  return {
    read: () => {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
      try {
        return parseApprovalState(JSON.parse(text));
      } catch {
        return { approved: [], denied: [] };
      }
    },
    create: (state) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      try {
        // A hard link fails when the target exists and a reader never sees a half-written file.
        linkSync(tmp, path);
        return true;
      } catch {
        return false;
      } finally {
        unlinkSync(tmp);
      }
    },
    write: (state) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
};

const CACHE_FILE = /^(.*)-[0-9a-f]{12}\.json$/;

/** Server names that have a schema cache or an approvals file in the directory. */
export const knownServers = (cacheDir: string): string[] => {
  const names = new Set<string>();
  const scan = (dir: string, pick: (file: string) => string | undefined): void => {
    try {
      for (const file of readdirSync(dir)) {
        const name = pick(file);
        if (name) names.add(name);
      }
    } catch {
      // no directory yet: nothing has run
    }
  };
  scan(cacheDir, (f) => CACHE_FILE.exec(f)?.[1]);
  scan(join(cacheDir, "approvals"), (f) => (f.endsWith(".json") ? f.slice(0, -".json".length) : undefined));
  return [...names].sort();
};

/** The tools the newest schema cache of a server lists (a server's launch line may have changed, leaving older files). */
export const cachedTools = (cacheDir: string, server: string): unknown[] | undefined => {
  let best: { file: string; at: number } | undefined;
  try {
    for (const file of readdirSync(cacheDir)) {
      const m = CACHE_FILE.exec(file);
      if (!m || m[1] !== safeName(server)) continue;
      const at = statSync(join(cacheDir, file)).mtimeMs;
      if (!best || at > best.at) best = { file, at };
    }
    if (!best) return undefined;
    const v: unknown = JSON.parse(readFileSync(join(cacheDir, best.file), "utf8"));
    const tools = v && typeof v === "object" ? (v as { tools?: unknown }).tools : undefined;
    return Array.isArray(tools) ? tools : undefined;
  } catch {
    return undefined;
  }
};

export type ServerApprovals = {
  readonly server: string;
  /** False until the proxy has baselined the server (the first run). */
  readonly baselined: boolean;
  readonly approved: readonly string[];
  readonly denied: readonly string[];
  /** Listed by the server (per its cache) and waiting for the owner. */
  readonly pending: readonly string[];
};

/** What the owner's `mcp-tools` command works with. */
export type McpToolsPort = {
  servers: () => string[];
  status: (server: string) => ServerApprovals;
  /** Fails with a reason when the server or tool is unknown. */
  approve: (server: string, tool: string) => string | undefined;
  deny: (server: string, tool: string) => string | undefined;
};

export const createMcpToolsPort = (cacheDir: string): McpToolsPort => {
  const storeOf = (server: string): ApprovalStore => createFileApprovalStore(approvalsPath(cacheDir, server));
  const status = (server: string): ServerApprovals => {
    const state = storeOf(server).read();
    const tools = cachedTools(cacheDir, server) ?? [];
    return {
      server,
      baselined: state !== undefined,
      approved: state?.approved ?? [],
      denied: state?.denied ?? [],
      // With no baseline the next run takes everything listed as approved, so nothing is pending yet.
      pending: state ? pendingOf(state, tools) : [],
    };
  };
  const change = (server: string, tool: string, apply: (s: ApprovalState, t: string) => ApprovalState): string | undefined => {
    if (!knownServers(cacheDir).includes(server)) return `unknown server \`${server}\``;
    const store = storeOf(server);
    const tools = cachedTools(cacheDir, server) ?? [];
    const state = store.read() ?? baselineOf(tools);
    if (!namesOf(tools).includes(tool) && !state.approved.includes(tool) && !state.denied.includes(tool)) {
      return `\`${server}\` does not list a tool \`${tool}\``;
    }
    store.write(apply(state, tool));
    return undefined;
  };
  return {
    servers: () => knownServers(cacheDir),
    status,
    approve: (server, tool) => change(server, tool, approveTool),
    deny: (server, tool) => change(server, tool, denyTool),
  };
};
