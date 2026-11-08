import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createStatsRepo } from "../../src/infrastructure/db/statsRepo.ts";

const DAY = 86_400_000;

const seed = () => {
  const db = openDatabase(":memory:");
  const msg = db.query("INSERT INTO messages (channel_id, slack_user_id, role, content, created_at) VALUES (?, ?, ?, 'x', ?)");
  msg.run("C1", "U1", "user", 1 * DAY + 10);
  msg.run("C1", "BOT", "assistant", 1 * DAY + 20);
  msg.run("C1", "U1", "user", 2 * DAY + 5);
  msg.run("C1", "U1", "user", 0 * DAY + 5); // before the window
  const turn = db.query(
    "INSERT INTO turn_log (channel_id, slack_user_id, outcome, started_at, ended_at) VALUES ('C1', ?, ?, ?, ?)",
  );
  turn.run("U1", "ok", 1 * DAY, 1 * DAY + 1);
  turn.run("U1", "failed", 1 * DAY, 1 * DAY + 2);
  turn.run("U2", "stopped", 2 * DAY, 2 * DAY + 1);
  const cmd = db.query(
    "INSERT INTO command_log (slack_user_id, command, args, channel_id, ok, result, created_at) VALUES (?, ?, '', 'C1', ?, '', ?)",
  );
  cmd.run("U2", "review", 1, 1 * DAY);
  cmd.run("U2", "review", 0, 1 * DAY);
  cmd.run("U2", "help", 1, 2 * DAY);
  cmd.run("U3", "help", 1, 0);
  const usage = db.query("INSERT INTO llm_usage (cost_usd, created_at) VALUES (?, ?)");
  usage.run(1.5, 1 * DAY);
  usage.run(0.25, 1 * DAY + 9);
  const sess = db.query(
    "INSERT INTO thread_sessions (channel_id, thread_ts, tier, session_id, created_at, used_at) VALUES ('C1', ?, ?, 's', 0, ?)",
  );
  sess.run("1.0", "full", 2 * DAY);
  sess.run("1.0", "sandboxed", 2 * DAY);
  sess.run("2.0", "full", 0);
  return createStatsRepo(db);
};

describe("stats repo", () => {
  test("buckets messages, turns and spend per day", () => {
    const s = seed();
    expect(s.messagesPerDay(DAY, 0)).toEqual([
      { day: 1, user: 1, assistant: 1 },
      { day: 2, user: 1, assistant: 0 },
    ]);
    expect(s.turnsPerDay(DAY, 0)).toEqual([
      { day: 1, ok: 1, failed: 1 },
      { day: 2, ok: 0, failed: 1 },
    ]);
    expect(s.spendPerDay(DAY, 0)).toEqual([{ day: 1, runs: 2, costUsd: 1.75 }]);
  });

  test("the offset moves rows across midnight", () => {
    expect(seed().messagesPerDay(0, DAY).map((r) => r.day)).toEqual([1, 2, 3]);
  });

  test("top commands and people inside the window", () => {
    const s = seed();
    expect(s.topCommands(DAY, 5)).toEqual([
      { key: "review", runs: 2, failed: 1 },
      { key: "help", runs: 1, failed: 0 },
    ]);
    expect(s.topUsers(DAY, 5)).toEqual([
      { key: "U2", turns: 1, commands: 3 },
      { key: "U1", turns: 2, commands: 0 },
    ]);
    expect(s.topUsers(DAY, 1)).toHaveLength(1);
  });

  test("a thread is counted once whatever its tiers", () => {
    const s = seed();
    expect(s.activeThreads(DAY)).toBe(1);
    expect(s.activeThreads(0)).toBe(2);
  });
});
