/**
 * Asking the cheap model whether a followed thread's batch is for the bot.
 *
 * It runs on the same LLM port as every other turn, with the policy the
 * composition root hands over: the `pal` model (Haiku by default), no tools,
 * a short timeout. Nothing here throws on a bad answer - `parseGateVerdict`
 * turns an unreadable one into `reply` - and a failed call is left to the
 * caller, which also fails open.
 */
import { gateMessage, gateSystem, parseGateVerdict, type GateContextLine, type GateDecision } from "../domain/followGate.ts";
import type { ToolPolicy } from "../domain/toolPolicy.ts";
import type { LlmPort } from "./ports.ts";

export type GateModelDeps = {
  llm: Pick<LlmPort, "complete">;
  /** The pal model, no tools, a short timeout. */
  policy: () => ToolPolicy;
  botName: () => string;
};

export type GateQuestion = {
  channel: string;
  threadTs: string;
  /** Who the call is billed to: the newest author in the batch. */
  actor: string;
  context: readonly GateContextLine[];
  batch: readonly { author: string; text: string }[];
};

export const createGateModel =
  (deps: GateModelDeps) =>
  async (q: GateQuestion): Promise<GateDecision> => {
    const botName = deps.botName();
    const raw = await deps.llm.complete({
      system: gateSystem(botName),
      messages: [
        {
          role: "user",
          content: gateMessage({ botName, context: q.context, batch: q.batch }),
          speakerId: q.actor,
        },
      ],
      policy: deps.policy(),
      bill: { actor: q.actor, kind: "follow-gate", channel: q.channel, threadTs: q.threadTs },
    });
    return parseGateVerdict(raw);
  };
