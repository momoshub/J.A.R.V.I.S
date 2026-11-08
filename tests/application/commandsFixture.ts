/** Shared deps and fakes for the command tests, split across several files. */

import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import type { ClaudeTokenPort } from "../../src/application/claudeTokens.ts";
import { type CommandDeps } from "../../src/application/commands.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import type { SlackAdminPort, SlackMessage } from "../../src/application/slackAdmin.ts";

export const OWNER = "U0OWNER0001";

export let db: DbClient;
export const actor = (over: Partial<AllowedUser> = {}): AllowedUser => ({
  slackId: OWNER,
  role: "owner",
  displayName: "Kai",
  addedBy: "system",
  createdAt: 0,
  ...over,
});

export const llm: LlmPort = { complete: async () => "drafted answer" };

export type SlackCalls = {
  posts: { channel: string; text: string; threadTs?: string; by?: string }[];
  reactions: string[];
  removed: { channel: string; ts: string }[];
  buttons: string[];
  settled: { channel: string; ts: string; text: string }[];
  removeError?: Error;
};

export const fakeSlack = (calls: SlackCalls, thread: SlackMessage[] = []): SlackAdminPort => ({
  listConversations: async () => [],
  history: async () => ({ messages: [] }),
  replies: async () => thread,
  update: async () => {},
  remove: async (channel, ts) => {
    if (calls.removeError) throw calls.removeError;
    calls.removed.push({ channel, ts });
  },
  post: async (channel, text, threadTs) => {
    calls.posts.push({ channel, text, threadTs });
  },
  postDm: async (userId, text) => {
    calls.posts.push({ channel: userId, text });
    return { channel: userId, ts: `dm-${calls.posts.length}` };
  },
  postDmInteractive: async (userId, text, actions) => {
    calls.posts.push({ channel: userId, text });
    calls.buttons.push(...actions.map((a) => `${a.actionId}:${a.value}`));
    return { channel: userId, ts: `notice-${calls.posts.length}` };
  },
  postInteractive: async (channel, text, actions, threadTs, by) => {
    calls.posts.push({ channel, text, threadTs, ...(by ? { by } : {}) });
    calls.buttons.push(...actions.map((a) => `${a.actionId}:${a.value}`));
    return { channel, ts: `interactive-${calls.posts.length}` };
  },
  postMenu: async () => undefined,
  settleInteractive: async (channel, ts, text) => {
    calls.settled.push({ channel, ts, text });
  },
  addReactions: async (_c, _ts, names) => {
    calls.reactions.push(...names);
    return names.length;
  },
  botUserId: async () => "UBOT",
  resolveNames: async () => ({}),
});

export let slackCalls: SlackCalls;

export const threadMsg = (text: string): SlackMessage => ({
  ts: "1.1",
  userId: "U1",
  userName: "Kai",
  text,
  replyCount: 0,
  own: false,
  mentionsBot: false,
});

/**
 * Everyone has a Claude token, so tests about review mechanics are not all
 * about the token gate. The gate has its own describe block, with its own store.
 */
export const everyoneHasToken = (): ClaudeTokenPort => ({
  get: () => `sk-ant-oat01-${"t".repeat(48)}`,
  has: () => true,
  set: () => {},
  remove: () => {},
  count: () => 1,
  list: () => [],
  asked: () => false,
  markAsked: () => {},
});

export const build = (thread: SlackMessage[] = [threadMsg("hi there")]): CommandDeps => {
  db = openDatabase(":memory:");
  slackCalls = { posts: [], reactions: [], removed: [], buttons: [], settled: [] };
  return {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    learnings: createLearningsRepo(db),
    llm,
    promptContext: () => ({ botName: "Evie", learnings: [] }),
    botInfo: () => ({ botName: "Evie", model: "claude-cli (opus)" }),
    clock: () => 42,
    ownerSlackId: OWNER,
    slack: fakeSlack(slackCalls, thread),
    draft: async () => "an AI-drafted reply",
    claudeTokens: everyoneHasToken(),
  };
};
