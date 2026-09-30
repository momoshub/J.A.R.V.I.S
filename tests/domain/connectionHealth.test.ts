import { describe, expect, test } from "bun:test";
import {
  CONNECTION_GRACE_MS,
  describeConnection,
  isListening,
  shouldGiveUp,
  type ConnectionHealth,
} from "../../src/domain/connectionHealth.ts";

const at = (state: ConnectionHealth["state"], since = 0): ConnectionHealth => ({ state, since });

describe("shouldGiveUp", () => {
  test("a connected socket is never a reason to restart", () => {
    expect(shouldGiveUp(at("connected"), CONNECTION_GRACE_MS * 10)).toBe(false);
  });

  test("a blip that heals itself is not worth dropping work over", () => {
    expect(shouldGiveUp(at("reconnecting"), 5_000)).toBe(false);
    expect(shouldGiveUp(at("disconnected"), CONNECTION_GRACE_MS - 1)).toBe(false);
  });

  test("still away after the grace period, the process gives up on itself", () => {
    expect(shouldGiveUp(at("disconnected"), CONNECTION_GRACE_MS)).toBe(true);
    expect(shouldGiveUp(at("disconnected"), CONNECTION_GRACE_MS + 60_000)).toBe(true);
  });

  test("reconnecting forever is the failure, not the recovery", () => {
    // the 22-hour outage was spent entirely here: a client that is trying is
    // not a client that is hearing anyone
    expect(shouldGiveUp(at("reconnecting"), CONNECTION_GRACE_MS)).toBe(true);
    expect(shouldGiveUp(at("connecting"), CONNECTION_GRACE_MS)).toBe(true);
    expect(shouldGiveUp(at("unknown"), CONNECTION_GRACE_MS)).toBe(true);
  });

  test("the grace period is caller's choice, for tests and for tuning", () => {
    expect(shouldGiveUp(at("disconnected"), 1_000, 500)).toBe(true);
    expect(shouldGiveUp(at("disconnected"), 1_000, 5_000)).toBe(false);
  });
});

test("isListening is only ever true when connected", () => {
  expect(isListening("connected")).toBe(true);
  for (const s of ["connecting", "reconnecting", "disconnected", "unknown"] as const) {
    expect(isListening(s)).toBe(false);
  }
});

describe("describeConnection", () => {
  test("says deaf out loud, so it is never just a silence", () => {
    expect(describeConnection(at("reconnecting"), 600_000)).toBe("NOT listening - reconnecting for 10m");
    expect(describeConnection(at("disconnected"), 45_000)).toBe("NOT listening - disconnected for 45s");
  });

  test("and says plainly when it is fine", () => {
    expect(describeConnection(at("connected"), 120_000)).toBe("listening, connected for 2m");
  });
});
