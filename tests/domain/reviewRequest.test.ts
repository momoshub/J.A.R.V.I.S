import { describe, expect, test } from "bun:test";
import { reviewRequestIn } from "../../src/domain/reviewRequest.ts";

const PR = "https://github.com/acme/acme-web/pull/8011";

describe("reviewRequestIn", () => {
  test("`@bot review <pr>` and `@bot approve <pr>` both mean quick-review", () => {
    expect(reviewRequestIn(`<@U0BOT000001|Jarvis> review ${PR}`)).toBe(`quick-review ${PR}`);
    expect(reviewRequestIn(`<@U0BOT000001> approve ${PR}`)).toBe(`quick-review ${PR}`);
    expect(reviewRequestIn(`<@U0BOT000001:Jarvis> Review ${PR} please`)).toBe(`quick-review ${PR}`);
    expect(reviewRequestIn(`<@U1> <@U2> approve ${PR}`)).toBe(`quick-review ${PR}`);
  });

  test("the verb has to come first, right after the tag", () => {
    expect(reviewRequestIn(`<@U1> can you review ${PR} please`)).toBeUndefined();
    expect(reviewRequestIn(`${PR} <@U1> please review when you get a sec`)).toBeUndefined();
    expect(reviewRequestIn(`<@U1> re-review ${PR}, I pushed a fix`)).toBeUndefined();
    expect(reviewRequestIn(`review ${PR}`)).toBeUndefined(); // not tagged at all
  });

  test("Slack's own link wrapping does not hide the url", () => {
    expect(reviewRequestIn(`<@U1> review <${PR}|acme-web#8011>`)).toBe(`quick-review ${PR}`);
  });

  test("several PRs, in order, once each", () => {
    const other = "https://github.com/o/r/pull/2";
    expect(reviewRequestIn(`<@U1> approve ${PR} and ${other} and ${PR}`)).toBe(`quick-review ${PR} ${other}`);
  });

  test("talk stays talk - running a review spends the asker's own credential", () => {
    expect(reviewRequestIn(`<@U1> what did you think of ${PR}`)).toBeUndefined();
    expect(reviewRequestIn("<@U1> review my standup notes")).toBeUndefined(); // no PR
    expect(reviewRequestIn(`<@U1> reviewer on ${PR}?`)).toBeUndefined(); // reviewer != review
    expect(reviewRequestIn(`<@U1> approved ${PR}`)).toBeUndefined(); // approved != approve
    expect(reviewRequestIn("")).toBeUndefined();
  });

  test("a flag said out loud carries through, prose does not", () => {
    expect(reviewRequestIn(`<@U1> review ${PR} --policy after`)).toBe(`quick-review ${PR} --policy after`);
    expect(reviewRequestIn(`<@U1> review ${PR} --after`)).toBe(`quick-review ${PR} --after`);
    // "when free" is not guidance, and guessing which half of a sentence
    // was meant as one is worse than not trying
    expect(reviewRequestIn(`<@U1> review ${PR} when free`)).toBe(`quick-review ${PR}`);
  });
});
