import { describe, expect, test } from "bun:test";
import { investigatePrompt } from "../../src/domain/investigatePrompt.ts";

const ctx = { channelId: "C1", threadTs: "100.1", askedBy: "U1" };

describe("investigatePrompt", () => {
  test("carries the question and the configured sources", () => {
    const p = investigatePrompt("why did /home crash", "Bot", ["grafana", "datadog"], "/bin/g.sh", ctx);
    expect(p).toContain("why did /home crash");
    expect(p).toContain("*grafana*");
    expect(p).toContain("*datadog*");
    expect(p).toContain("/bin/g.sh"); // the helper path is substituted, not a placeholder
  });

  test("reads the thread first, since the report lives there", () => {
    const p = investigatePrompt("q", "Bot", ["grafana"], undefined, ctx);
    expect(p).toContain("READ THAT THREAD FIRST");
    expect(p).toContain("100.1");
  });

  test("outside a thread it does not promise to read one", () => {
    const p = investigatePrompt("q", "Bot", ["grafana"], undefined, { ...ctx, threadTs: undefined });
    expect(p).not.toContain("READ THAT THREAD FIRST");
    expect(p).toContain("C1");
  });

  test("the counting and blast-radius traps are stated, because both were hit", () => {
    // the real failure: "12 errors from 4 users, US only" when it was 12 from
    // 10 users across two regions, because each crash emits ~4 RUM events
    const p = investigatePrompt("q", "Bot", ["datadog"], undefined, ctx);
    expect(p).toContain("find the de-duplicating field before quoting a number");
    expect(p).toContain("Every environment and region");
  });

  test("an id that returns nothing is questioned, not concluded from", () => {
    // the session id in the report was an app header, not a RUM session id, so
    // the empty vlogs/Tempo results meant nothing
    expect(investigatePrompt("q", "Bot", ["grafana"], undefined, ctx)).toContain(
      "question whether it is the right kind of id",
    );
  });

  test("it reports which source answered, and never blurs unreachable with empty", () => {
    const p = investigatePrompt("q", "Bot", ["grafana", "datadog"], undefined, ctx);
    expect(p).toContain("say which source answered you");
    expect(p).toContain('"I could not reach X" and "X has nothing"');
  });

  test("looking is the job - it does not file or fix anything uninvited", () => {
    const p = investigatePrompt("q", "Bot", ["grafana"], undefined, ctx);
    expect(p).toContain("Do not raise a ticket, do not open a PR");
  });
});
