/**
 * The Refiner: the pass that curates memory between conversations.
 *
 * This is the job nobody was ever going to do by hand. Facts arrived one at a
 * time, each one reasonable on its own, and the list they landed in was never
 * read back as a whole - so it kept a claim and the correction that replaced
 * it, two wordings of one instruction, and a dozen facts about one repository
 * that loaded into every conversation about anything.
 *
 * Curation is a different act from learning, and it needs the whole directory
 * in front of it at once. That is what this prompt is for.
 *
 * It runs against a STAGING COPY. The brain edits files freely, and the command
 * that spawned it reads the result, puts it through the gate and commits it as
 * a revision. The live adapter is never written by the model directly: a refine
 * that loses something has to be revertible, and the thing doing the losing
 * cannot also be the thing deciding the write was fine.
 */
import { CHANNELS_DIR, NOTES_FILE, PEOPLE_DIR, POLICY_FILE, SKILLS_DIR } from "./adapter.ts";
import { SLACK_FORMAT } from "./slackFormat.ts";

export type RefineRequest = {
  /** Always-on bytes the adapter currently spends. */
  readonly currentBytes: number;
  /** Ceiling the refined adapter must come in under. */
  readonly budget: number;
  /** Anything the caller said to aim the pass. */
  readonly note?: string;
};

export const refinePrompt = (req: RefineRequest, botName: string): string => {
  const over = req.currentBytes > req.budget;
  const steer = req.note?.trim()
    ? `\n\nWhat they asked for, in their words:\n"""\n${req.note.trim()}\n"""\nDo that as well. It aims the pass; it does not license dropping anything you were not going to drop anyway.`
    : "";

  return `You are curating ${botName}'s memory. You are in a working copy of it - edit the files in place.

This is YOUR memory. Every line in it is something you will carry into future conversations, so read it as what you currently believe, not as somebody else's document.

The layout:
- \`${POLICY_FILE}\` - your policy. Rules about how you behave, loaded into EVERY conversation. Keep it short.
- \`${NOTES_FILE}\` - facts loaded into every conversation. Also keep short.
- \`${PEOPLE_DIR}/<SLACKID>.md\` - what you know about one person. Loaded only when they are in the conversation.
- \`${CHANNELS_DIR}/<CHANNELID>.md\` - what you know about one channel. Loaded only in that channel.
- \`${SKILLS_DIR}/<slug>/SKILL.md\` - something you know in depth. Only its \`description:\` is always loaded; you read the body when it turns out to be relevant. Frontmatter needs \`name:\` and \`description:\`.

The budget: the always-on part - policy plus global notes plus the one-line skill descriptions - must come in under *${req.budget} bytes*. It is currently *${req.currentBytes}*.${
    over
      ? " You are over it. Something has to be scoped or promoted, and this is the pass that does it."
      : " You have room, which is not a reason to use it."
  }

What to do, in order:

1. *Read all of it first.* Every file. You cannot merge what you have not read, and the duplicates are rarely adjacent.

2. *Resolve contradictions.* When two entries disagree, the later one wins and the earlier one goes. An entry that begins "Correction:" or "Actually:" is the survivor - and it should stop announcing that it is a correction, because once the thing it corrects is gone there is nothing left to correct. Rewrite it as a plain statement.

3. *Merge duplicates.* Two entries saying the same thing in different words become one. Keep the clearer wording, keep any detail only the other one had.

4. *Scope what is not general.* A fact about one person belongs in their file. A fact about one channel belongs in that channel's file. The filename is the Slack id - \`U...\` for a person, \`C\`/\`D\`/\`G\` for a channel - because that is how it gets loaded; a file named anything else is memory that will never load again. If you do not know the id, leave the entry where it is rather than guessing one.

5. *Promote what is deep.* Anything procedural, or about one repository, system or workflow - a release process, how a service is laid out, a convention that only applies when touching some particular thing - becomes a skill. Give it a description precise enough that you can tell from the description alone whether to open it. "Release process" is useless; "how releases are cut and promoted, branch by branch" tells you when you need it. Several related entries usually make ONE skill, not several.

6. *Retire what is dead.* Something superseded by a later entry, or about a thing that no longer exists, goes. *Nothing else goes.* If you are not sure, keep it - unsure is not the same as stale, and this is the only copy.

7. *Leave the policy small.* ${POLICY_FILE} is for rules about how you behave. Facts are not rules. If a line could be phrased as "X is true" rather than "do X", it is a note, not policy.

Hard rules:
- *Never invent.* Every line you write must trace to a line that was already there. You are reorganising and rewording, not adding. If you think something is missing, say so in your report - do not write it in.
- *Never drop something just to fit the budget.* Scope it or promote it. Dropping is only for superseded and dead entries, and your report names every single one with the reason.
- Keep a person's id, a channel's id, a URL, a repository name exactly as written. These are the parts that are useless if subtly wrong.
- Do not touch \`adapter.yaml\`, \`check.py\`, \`README.md\` or anything under \`.git\`.
- Work quietly. No commentary while you work, no questions - nobody is watching this run, so a question is a decision left unmade.

When you are done, report back. ${SLACK_FORMAT}
- first line: what the pass did, in one sentence with the numbers - entries in, entries out, what moved where
- then the specifics, worst first: every contradiction you resolved (both sides, and which won), every merge, everything you retired AND why
- then anything you deliberately left alone that still looks wrong - an entry you could not scope because you had no id, something that reads as stale but you were not sure enough to drop
- keep it to fifteen lines. The detail is in the diff; what they need from you is the judgement calls${steer}`;
};
