/**
 * Delivering a command the brain ran on someone's behalf.
 *
 * Two different things keep output out of the thread, and they are not the same:
 *
 * - `quiet` is the COMMAND's own nature. It is a tool (`users`, `spend`, `help`):
 *   its result comes back to the caller even when the person asked for it, and
 *   `show` does not change that.
 * - `show` is the PERSON's ask. A command the brain runs on its own - checking
 *   `mindful`, starting a `quick-review` nobody requested - is HIDDEN by default: the
 *   output goes back to the brain only, and nothing at all is posted, no
 *   progress and no result. The brain passes `--show` only when the person in
 *   the thread directly asked for that command, and then it is an errand whose
 *   result belongs in the thread, so the bot posts it there itself and tells
 *   the caller it did.
 *
 * It used to hand a fast errand's result back unposted while the prompt said
 * commands post their own output, so `users` printed nothing anywhere: the
 * brain trusted the prompt and summarised a list nobody had seen. Then every
 * command the brain ran posted, and its own status checks (`mindful`, a
 * `quick-review` it started unasked, "`quick-review` ran past its time limit") landed in
 * the thread as noise. Now the outcome says in so many words whether the thread
 * has it.
 *
 * What this does NOT hide: anything a command posts by itself outside `post` and
 * `reply` (a picker, a Block Kit card sent straight to Slack, a review on
 * GitHub). Hiding is only about what goes through this bridge. Since a hidden
 * run has a `reply`, the token / secret asks that gate on it still post their
 * buttons: those need the person's hand, so they are meant to show. A
 * `workflow` posts its later steps by itself, so the brain passes `--show` for
 * one - it is always something the person asked for.
 */

import { readableText } from "../domain/blockKit.ts";
import { logAndIgnore } from "./ignoredError.ts";

export type BrainRunOutcome = {
  result: string;
  /** True when the thread has (or will get) the output, so the caller must not repeat it. */
  posted: boolean;
};

export type BrainRunDeps = {
  /** The command's own output mode: quiet answers the caller, not the thread, whoever asked. */
  quiet: boolean;
  /** The person directly asked for this command (`--show`): only then may its output reach the thread. */
  show: boolean;
  /** Start the command; `reply` is how it posts progress: absent for a quiet one, a collecting sink for a hidden one. */
  start: (reply?: (text: string) => Promise<void>) => Promise<string>;
  post: (text: string) => Promise<void>;
  /** How long the caller is held before a slow command is left to finish on its own. */
  handoffMs: number;
  /** A hidden command's failure after the hand-off. It is logged, never posted. */
  onLateError: (e: unknown) => void;
  /** A hidden command's result after the hand-off. It is logged, never posted. */
  onLateResult?: (text: string) => void;
};

export const STARTED_MESSAGE = "started - it reports into the thread as it goes";

export const HIDDEN_RUNNING_MESSAGE =
  "still running in the background - its output is hidden (nothing is posted to the thread) and will not come back to you";

export const runForBrain = async (deps: BrainRunDeps): Promise<BrainRunOutcome> => {
  // A tool-like command answers its CALLER, who waits on it to carry on.
  // The caller reads words: a Block Kit reply (`sys`) comes back as its own text.
  if (deps.quiet) return { result: readableText(await deps.start()), posted: false };

  // Nobody asked for this one: it is the brain's own check or errand, so the
  // thread hears nothing - no progress, no result, no late failure.
  // It still gets a `reply`, a sink that collects instead of posting: commands
  // read a missing `reply` as "no Slack" and take a one-shot path, so a hidden
  // `quick-review` once skipped its approve-after and CI hand-off entirely.
  if (!deps.show) {
    const lines: string[] = [];
    const collected = (text: string) => [...lines, text].filter((t) => t.trim()).join("\n\n");
    const run = deps.start(async (text) => void lines.push(text));
    const settled = await Promise.race([
      run.then((text) => ({ done: true as const, text })),
      new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), deps.handoffMs)),
    ]);
    if (settled.done) return { result: readableText(collected(settled.text)), posted: false };
    run.then((text) => deps.onLateResult?.(collected(text))).catch((e: unknown) => deps.onLateError(e));
    return { result: HIDDEN_RUNNING_MESSAGE, posted: false };
  }

  const run = deps.start(deps.post);
  // Do not make the caller wait. The chat turn is a CLI process on a
  // chat-length timeout, and a `quick-review` or `ticket` runs for minutes -
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
      return deps.post(`⚠️ that one stopped without a result - ${why}`).catch(logAndIgnore("brain run stopped notice"));
    });
  return { result: STARTED_MESSAGE, posted: true };
};
