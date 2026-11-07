import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createWebhookHandler, type WebhookDelivery } from "../../../src/infrastructure/github/webhookServer.ts";

const SECRET = "s3cret";
const body = JSON.stringify({ action: "created" });
const sig = (b: string, s = SECRET) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;

const setup = () => {
  const got: WebhookDelivery[] = [];
  const handler = createWebhookHandler({ secret: () => SECRET, onDelivery: (d) => void got.push(d) });
  const post = (path: string, signature: string) =>
    handler(
      new Request(`http://127.0.0.1${path}`, {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": signature, "x-github-event": "issue_comment", "x-github-delivery": "d1" },
      }),
    );
  return { got, handler, post };
};

describe("webhook handler", () => {
  test("accepts a signed delivery on either path, with or without the Funnel prefix", async () => {
    const { got, post } = setup();
    expect((await post("/github/webhook", sig(body))).status).toBe(202);
    expect((await post("/webhook", sig(body))).status).toBe(202);
    expect(got.map((d) => d.event)).toEqual(["issue_comment", "issue_comment"]);
    expect(got[0]?.id).toBe("d1");
  });

  test("rejects a bad signature with 401 and hands nothing over", async () => {
    const { got, post } = setup();
    expect((await post("/github/webhook", sig(body, "wrong"))).status).toBe(401);
    expect(got).toEqual([]);
  });

  test("setup answers on both paths; everything else is 404", async () => {
    const { handler } = setup();
    for (const p of ["/github/setup?code=abc", "/setup"]) {
      const res = await handler(new Request(`http://127.0.0.1${p}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("close this tab");
    }
    expect((await handler(new Request("http://127.0.0.1/github/webhook"))).status).toBe(404);
    expect((await handler(new Request("http://127.0.0.1/other", { method: "POST" }))).status).toBe(404);
  });
});
