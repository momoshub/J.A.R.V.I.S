/**
 * Delivering a command the brain ran on someone's behalf.
 *
 * Every command has an output mode, and the brain has to know which one it
 * got. A `quiet` command is a tool: its result comes back to the caller and
 * nobody else sees it. Everything else is an errand whose result belongs in
 * the thread - so the bot posts it there itself, and tells the caller it did.
 *
 * It used to hand a fast errand's result back unposted while the prompt said
 * commands post their own output, so `users` printed nothing anywhere: the
 * brain trusted the prompt and summarised a list nobody had seen. Now the
 * outcome says in so many words whether the thread has it.
 */

import { readableText } from "../domain/blockKit.ts";

export type BrainRunOutcome = {
  result: string;
  /** True when the thread has (or will get) the output, so the caller must not repeat it. */
  posted: boolean;
};

export type BrainRunDeps = {
  /** The command's output mode: quiet answers the caller, not the thread. */
  quiet: boolean;
  /** Start the command; `reply` is how it posts progress, absent for a quiet one. */
  start: (reply?: (text: string) => Promise<void>) => Promise<string>;
  post: (text: string) => Promise<void>;
  /** How long the caller is held before a slow command is left to finish on its own. */
  handoffMs: number;
  onLateError: (e: unknown) => void;
};

export const STARTED_MESSAGE = "started - it reports into the thread as it goes";

export const runForBrain = async (deps: BrainRunDeps): Promise<BrainRunOutcome> => {
  // A tool-like command answers its CALLER, who waits on it to carry on.
  // The caller reads words: a Block Kit reply (`sys`) comes back as its own text.
  if (deps.quiet) return { result: readableText(await deps.start()), posted: false };

  const run = deps.start(deps.post);
  // Do not make the caller wait. The chat turn is a CLI process on a
  // chat-length timeout, and a `review` or `ticket` runs for minutes -
  // blocking here would kill that turn over a command that is working fine.
  const settled = await Promise.race([
    run.then((text) => ({ done: true as const, text })),
    new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), deps.handoffMs)),
  ]);
  if (settled.done) {
    if (!settled.text.trim()) return { result: "", posted: false };
    await deps.post(settled.text);
    return { result: readableText(settled.text), posted: true };
  }
  // Nobody is waiting on it any more, so a failure has to be SAID in the
  // thread. Logged only, the thread sat on "investigating" for good and the
  // next turn, seeing no result, quietly ran the whole job again.
  run
    .then((text) => {
      if (text.trim()) return deps.post(text);
    })
    .catch((e: unknown) => {
      deps.onLateError(e);
      const why = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      return deps.post(`⚠️ that one stopped without a result - ${why}`).catch(() => undefined);
    });
  return { result: STARTED_MESSAGE, posted: true };
};
