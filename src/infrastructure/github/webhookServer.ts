/**
 * The GitHub App's HTTP listener: loopback only, reached from the internet
 * through Tailscale Funnel.
 *
 * Funnel maps `https://<host>/github` here, and whether it strips that prefix
 * depends on how it was set up - so both `/github/webhook` and `/webhook` are
 * the webhook, and the same for `/setup`. Everything else is 404.
 *
 * A delivery is verified, handed over, and answered at once: GitHub gives a
 * webhook ten seconds, and a turn takes minutes.
 */
import { verifySignature } from "../../domain/githubApp.ts";

export type WebhookDelivery = { id: string; event: string; payload: unknown };

export type WebhookServerConfig = {
  port: number;
  /** Read per request, so a rotated secret file needs no restart. */
  secret: () => string;
  onDelivery: (d: WebhookDelivery) => void;
  log?: (line: string) => void;
};

const WEBHOOK_PATHS = new Set(["/webhook", "/github/webhook"]);
const SETUP_PATHS = new Set(["/setup", "/github/setup"]);

const SETUP_PAGE =
  "<!doctype html><meta charset=utf-8><title>GitHub App</title><p>ok, you can close this tab.</p>";

/** The request handler, apart from `Bun.serve`, so it can be tested directly. */
export const createWebhookHandler = (config: Omit<WebhookServerConfig, "port">) => {
  const log = config.log ?? (() => {});
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && SETUP_PATHS.has(path)) {
      // The manifest/installation code in the query is for a human to handle.
      return new Response(SETUP_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (req.method !== "POST" || !WEBHOOK_PATHS.has(path)) return new Response("not found", { status: 404 });

    const raw = new Uint8Array(await req.arrayBuffer());
    if (!verifySignature(config.secret(), raw, req.headers.get("x-hub-signature-256"))) {
      log("rejected a delivery with a bad signature");
      return new Response("bad signature", { status: 401 });
    }
    const event = req.headers.get("x-github-event") ?? "";
    const id = req.headers.get("x-github-delivery") ?? "";
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (!event || !id) return new Response("missing event or delivery id", { status: 400 });
    try {
      config.onDelivery({ id, event, payload });
    } catch (e) {
      log(`delivery ${id} could not be taken: ${e instanceof Error ? e.message : String(e)}`);
      return new Response("not stored", { status: 500 });
    }
    return new Response("accepted", { status: 202 });
  };
};

export const startWebhookServer = (config: WebhookServerConfig): { stop: () => void; port: number } => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    maxRequestBodySize: 26 * 1024 * 1024,
    fetch: createWebhookHandler(config),
  });
  return { stop: () => server.stop(true), port: server.port ?? config.port };
};
