import { describe, expect, test } from "bun:test";
import { toMrkdwn } from "../../src/domain/slackFormat.ts";

describe("toMrkdwn", () => {
  test("the constructs Slack cannot render are rewritten", () => {
    // what a real reply looked like: literal asterisks all through it
    expect(toMrkdwn("**Crashes:** 12")).toBe("*Crashes:* 12");
    expect(toMrkdwn("- **Users:** 10 distinct")).toBe("- *Users:* 10 distinct");
    expect(toMrkdwn("__also bold__")).toBe("*also bold*");
    expect(toMrkdwn("see [the PR](https://github.com/o/r/pull/1)")).toBe("see <https://github.com/o/r/pull/1|the PR>");
    expect(toMrkdwn("## Heading")).toBe("*Heading*");
    expect(toMrkdwn("### Deep heading ###")).toBe("*Deep heading*");
    expect(toMrkdwn("* a bullet\n+ another")).toBe("- a bullet\n- another");
  });

  test("code is never touched - `**ptr` is code, not emphasis", () => {
    expect(toMrkdwn("`**ptr` stays")).toBe("`**ptr` stays");
    expect(toMrkdwn("```js\nconst a = **x**;\n```\nand **this**")).toBe("```js\nconst a = **x**;\n```\nand *this*");
    // a fenced block containing something link-shaped survives intact
    expect(toMrkdwn("```\n[a](https://b.c)\n```")).toBe("```\n[a](https://b.c)\n```");
  });

  test("an unpaired marker cannot swallow the rest of the message", () => {
    expect(toMrkdwn("a ** b and c ** d")).toBe("a ** b and c ** d");
    expect(toMrkdwn("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(toMrkdwn("**open but never closed")).toBe("**open but never closed");
  });

  test("what is already mrkdwn is left exactly as it is", () => {
    const already = "*bold* _italic_ ~struck~ <https://x.y|label> <@U123> <#C1>\n- a bullet\n> a quote";
    expect(toMrkdwn(already)).toBe(already);
  });

  test("empty input stays empty", () => {
    expect(toMrkdwn("")).toBe("");
  });
});
