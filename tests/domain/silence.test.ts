import { describe, expect, test } from "bun:test";
import { isSilenceNote } from "../../src/domain/silence.ts";

describe("isSilenceNote", () => {
  test("the placeholder that actually got posted is caught", () => {
    expect(isSilenceNote("(empty reply — nothing to add here)")).toBe(true);
  });

  test("other ways of announcing silence are caught", () => {
    for (const t of ["_no reply needed_", "Nothing to add.", "(staying quiet)", "no response", "*silence*"]) {
      expect(isSilenceNote(t)).toBe(true);
    }
  });

  test("a real answer is never swallowed", () => {
    for (const t of [
      "",
      "done, the PG side is applied on sg-stg",
      "nothing to add from me, but the index is missing on sg-stg - see `role_assignment_brands`, it still has no unique (account_id, id) index",
      "no, that one is for the Team pod",
    ]) {
      expect(isSilenceNote(t)).toBe(false);
    }
  });
});
