import { describe, expect, test } from "bun:test";
import { reviewRequestIn } from "../../src/domain/reviewRequest.ts";

const PR = "https://github.com/acme/acme-fe/pull/8011";

describe("reviewRequestIn", () => {
  test("the shape people actually type", () => {
    expect(reviewRequestIn(`<@U0BOT000001|Jarvis> review ${PR}`)).toBe(`review ${PR}`);
    expect(reviewRequestIn(`<@U1> can you review ${PR} please`)).toBe(`review ${PR}`);
    expect(reviewRequestIn(`${PR} <@U1> please review when you get a sec`)).toBe(`review ${PR}`);
    expect(reviewRequestIn(`<@U1> re-review ${PR}, I pushed a fix`)).toBe(`review ${PR}`);
  });

  test("Slack's own link wrapping does not hide the url", () => {
    expect(reviewRequestIn(`<@U1> review <${PR}|acme-fe#8011>`)).toBe(`review ${PR}`);
  });

  test("several PRs, in order, once each", () => {
    const other = "https://github.com/o/r/pull/2";
    expect(reviewRequestIn(`review ${PR} and ${other} and ${PR}`)).toBe(`review ${PR} ${other}`);
  });

  test("talk stays talk - running a review spends the asker's own credential", () => {
    expect(reviewRequestIn(`<@U1> what did you think of ${PR}`)).toBeUndefined();
    expect(reviewRequestIn("<@U1> review my standup notes")).toBeUndefined(); // no PR
    expect(reviewRequestIn(`<@U1> who is the reviewer on ${PR}`)).toBeUndefined(); // reviewer != review
    expect(reviewRequestIn("")).toBeUndefined();
  });

  test("a flag said out loud carries through, prose does not", () => {
    expect(reviewRequestIn(`<@U1> review ${PR} --policy after`)).toBe(`review ${PR} --policy after`);
    expect(reviewRequestIn(`<@U1> review ${PR} --after`)).toBe(`review ${PR} --after`);
    // "can you please" is not guidance, and guessing which half of a sentence
    // was meant as one is worse than not trying
    expect(reviewRequestIn(`<@U1> can you please review ${PR} when free`)).toBe(`review ${PR}`);
  });
});
