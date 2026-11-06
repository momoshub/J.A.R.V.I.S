/**
 * Block Kit interactions the brain built itself.
 *
 * The bot only ever answered the buttons it was born with - approve, token,
 * the command menu. A button or a modal the model posted had no listener, so a
 * press showed the person a red error and the model never heard of it. Every
 * element whose `action_id` (and every view whose `callback_id`) starts with
 * `jv:` now belongs to the model: the press is acked at once and handed back
 * to the thread as a turn, written as a short note of who did what.
 *
 * A modal is the one thing a turn cannot open by itself. `views.open` wants a
 * `trigger_id`, which only a real click carries, it expires in three seconds,
 * and a turn takes longer than that to even start. So the model stores the
 * view first and posts a button pointing at it (`jv:modal:<id>`); the click
 * opens the stored view straight from the listener, with the thread tucked
 * into `private_metadata` so the submission finds its way home.
 */

export const KIT_PREFIX = "jv:";
export const KIT_MODAL_PREFIX = "jv:modal:";
/** Matches every action id and callback id the model owns. */
export const KIT_PATTERN = /^jv:/;

/** Slack caps `private_metadata` at 3000 characters. */
const METADATA_MAX = 3000;

export type KitThread = { readonly channelId: string; readonly threadTs: string };

export type KitView = Record<string, unknown>;

/** The stored view a `jv:modal:<id>` button opens, or undefined for any other id. */
export const modalIdOf = (actionId: string): string | undefined => {
  if (!actionId.startsWith(KIT_MODAL_PREFIX)) return undefined;
  const id = actionId.slice(KIT_MODAL_PREFIX.length).trim();
  return id || undefined;
};

/**
 * The thread rides in the view's metadata, next to whatever the model put
 * there itself, so the submission is routed without a lookup.
 */
export const encodeKitMeta = (thread: KitThread, own?: string): string =>
  JSON.stringify({ c: thread.channelId, t: thread.threadTs, ...(own ? { m: own } : {}) });

export const decodeKitMeta = (raw: string | undefined): { thread?: KitThread; own?: string } => {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as { c?: unknown; t?: unknown; m?: unknown };
    const thread =
      typeof v.c === "string" && typeof v.t === "string" && v.c && v.t ? { channelId: v.c, threadTs: v.t } : undefined;
    return { thread, own: typeof v.m === "string" ? v.m : undefined };
  } catch {
    return {};
  }
};

/** Why a view the model wants stored would not open, or undefined when it is fine. */
export const viewProblem = (view: unknown): string | undefined => {
  if (typeof view !== "object" || view === null || Array.isArray(view)) return "view must be a JSON object";
  const v = view as KitView;
  if (v.type !== undefined && v.type !== "modal") return 'only "modal" views can be opened from a button';
  if (!Array.isArray(v.blocks)) return "view needs a blocks array";
  if (typeof (v.title as { text?: unknown } | undefined)?.text !== "string") return "view needs a plain_text title";
  return undefined;
};

/**
 * The stored view, made routable: always a modal, always a `jv:` callback id
 * so the submission reaches the catch-all, and the thread in its metadata.
 */
export const prepareModal = (view: KitView, id: string, thread: KitThread): KitView => {
  const callback = typeof view.callback_id === "string" && KIT_PATTERN.test(view.callback_id)
    ? view.callback_id
    : `${KIT_PREFIX}view:${id}`;
  const own = typeof view.private_metadata === "string" ? view.private_metadata : undefined;
  const meta = encodeKitMeta(thread, own);
  return {
    ...view,
    type: "modal",
    callback_id: callback,
    private_metadata: meta.length <= METADATA_MAX ? meta : encodeKitMeta(thread),
  };
};

type Option = { value?: string; text?: { text?: string } };

/** One interactive element's current value, whatever kind of element it is. */
export type KitElementState = {
  type?: string;
  value?: string | null;
  selected_option?: Option | null;
  selected_options?: Option[];
  selected_date?: string | null;
  selected_time?: string | null;
  selected_date_time?: number | null;
  selected_user?: string | null;
  selected_users?: string[];
  selected_conversation?: string | null;
  selected_conversations?: string[];
  selected_channel?: string | null;
  selected_channels?: string[];
  rich_text_value?: unknown;
  files?: { name?: string; url_private?: string }[];
  timezone?: string;
};

const optionText = (o: Option): string => o.value ?? o.text?.text ?? "";

/** Flatten a rich text value to its plain text, which is all a turn needs. */
const richText = (v: unknown): string => {
  if (typeof v !== "object" || v === null) return "";
  const node = v as { text?: unknown; elements?: unknown[]; user_id?: unknown; url?: unknown };
  if (typeof node.text === "string") return node.text;
  if (typeof node.user_id === "string") return `<@${node.user_id}>`;
  if (typeof node.url === "string") return node.url;
  return Array.isArray(node.elements) ? node.elements.map(richText).join("") : "";
};

/** The value an element holds, as text, or undefined when nothing is picked. */
export const elementValue = (e: KitElementState): string | undefined => {
  const list = (xs: readonly string[] | undefined, wrap = (s: string) => s) =>
    xs && xs.length ? xs.map(wrap).join(", ") : undefined;
  const user = (id: string) => `<@${id}>`;
  const channel = (id: string) => `<#${id}>`;
  if (typeof e.value === "string") return e.value;
  if (e.selected_option) return optionText(e.selected_option);
  if (e.selected_options) return list(e.selected_options.map(optionText));
  if (e.selected_date) return e.selected_date;
  if (e.selected_time) return e.selected_time;
  if (typeof e.selected_date_time === "number") return new Date(e.selected_date_time * 1000).toISOString();
  if (e.selected_user) return user(e.selected_user);
  if (e.selected_users) return list(e.selected_users, user);
  if (e.selected_conversation) return channel(e.selected_conversation);
  if (e.selected_conversations) return list(e.selected_conversations, channel);
  if (e.selected_channel) return channel(e.selected_channel);
  if (e.selected_channels) return list(e.selected_channels, channel);
  if (e.rich_text_value) return richText(e.rich_text_value) || undefined;
  if (e.files) return list(e.files.map((f) => f.url_private ?? f.name ?? "file"));
  return undefined;
};

/** Every filled field of a view's state, as `block_id.action_id = value` lines. */
export const stateLines = (values: Record<string, Record<string, KitElementState>> | undefined): string[] =>
  Object.entries(values ?? {}).flatMap(([block, actions]) =>
    Object.entries(actions).map(([action, e]) => {
      const v = elementValue(e);
      return `- \`${block}.${action}\`: ${v === undefined || v === "" ? "_(empty)_" : v}`;
    }),
  );

const quoted = (v: string | undefined): string => (v === undefined || v === "" ? "" : ` with value \`${v}\``);

/** The turn a press becomes: who, which element, what it now holds. */
export const describeAction = (a: {
  userId: string;
  actionId: string;
  type?: string;
  value?: string;
  blockId?: string;
  inModal?: string;
}): string =>
  `[block kit event] <@${a.userId}> used \`${a.actionId}\`` +
  `${a.type ? ` (${a.type})` : ""}${a.blockId ? ` in block \`${a.blockId}\`` : ""}` +
  `${a.inModal ? ` inside the modal "${a.inModal}"` : " on a message in this thread"}${quoted(a.value)}`;

/** The turn a submitted modal becomes. */
export const describeSubmission = (s: {
  userId: string;
  callbackId: string;
  title?: string;
  own?: string;
  fields: readonly string[];
}): string =>
  [
    `[block kit event] <@${s.userId}> submitted the modal${s.title ? ` "${s.title}"` : ""} (\`${s.callbackId}\`)`,
    ...(s.own ? [`its private_metadata: \`${s.own}\``] : []),
    ...(s.fields.length ? s.fields : ["- no fields"]),
  ].join("\n");

/** The turn a modal closed without submitting becomes (only with notify_on_close). */
export const describeClosed = (c: { userId: string; callbackId: string; title?: string }): string =>
  `[block kit event] <@${c.userId}> closed the modal${c.title ? ` "${c.title}"` : ""} (\`${c.callbackId}\`) without submitting`;

/** What the brain is told, so it can build things people can press. */
export const kitRules = (kitUrl: string): string => {
  if (!kitUrl) return "";
  return `

Interactive Block Kit (buttons, selects, modals):
- any element whose action_id starts with "jv:" is yours: when someone uses it, the press comes back to this thread as a new turn starting "[block kit event]", from the person who pressed. Every element type works - buttons, static/user/channel selects, multi-selects, overflow, checkboxes, radio buttons, date/time pickers
- post interactive blocks yourself with chat.postMessage and the bot token, always with thread_ts of this thread so the event finds its way back here. A blockkit fence is for display only
- give each element a meaningful id ("jv:approve-refund") and a value that tells you what it was about, since the turn only sees the id, the value and who pressed
- a modal opens only from a click. Store it first, then post a button whose action_id is the one it gives back:
  curl -s -X POST -H "Content-Type: application/json" -d '{"view":{"type":"modal","title":{"type":"plain_text","text":"..."},"submit":{"type":"plain_text","text":"Submit"},"blocks":[...]}}' ${kitUrl}
  -> {"ok":true,"action_id":"jv:modal:<id>"}. The submission comes back here as a turn listing every field as block_id.action_id: value. Add "notify_on_close":true to hear about a cancel too
- external selects (options loaded live) are not supported: use static options
- a question with a fixed set of answers (a or b, yes or no, pick one of these) is asked with buttons, never as lettered options in text. Put the question in a section block and one jv: button per answer, the value naming the answer
- you do not disable them yourself: a press locks the message at once, showing who chose what, and a typed reply in the thread retires any buttons still open. Just act on the answer
- a turn is not instant, so when a press needs a visible reaction, update the message with chat.update once you have acted on it`;
};

/**
 * A choice question is answered once. Buttons that stay live after the
 * answer invite a second press, and a stale question sitting under a typed
 * answer reads as still open. So a press on a single-shot element locks the
 * message, and a typed reply in the thread retires whatever is still open.
 * Multi-selects and checkboxes are left alone: picking several IS the point.
 */
const SINGLE_SHOT = new Set([
  "button",
  "overflow",
  "static_select",
  "radio_buttons",
  "users_select",
  "conversations_select",
  "channels_select",
  "datepicker",
  "timepicker",
  "datetimepicker",
]);

/** Whether a press answers the question it sits on (and so should lock it). */
export const locksOnPress = (type: string | undefined, actionId: string): boolean =>
  !!type && SINGLE_SHOT.has(type) && !modalIdOf(actionId);

export type KitBlock = Record<string, unknown>;

type Element = { action_id?: unknown; text?: { text?: unknown } };

const isKitElement = (e: unknown): boolean =>
  typeof e === "object" && e !== null && typeof (e as Element).action_id === "string" &&
  KIT_PATTERN.test((e as Element).action_id as string);

const blockHasKit = (b: KitBlock): boolean =>
  (Array.isArray(b.elements) && b.type === "actions" && b.elements.some(isKitElement)) || isKitElement(b.accessory);

/** Whether a posted message still carries elements of ours someone could press. */
export const hasLiveKit = (blocks: readonly KitBlock[] | undefined): boolean => (blocks ?? []).some(blockHasKit);

/** What the person picked, as they saw it: the button's label, or the option's. */
export const pickedLabel = (a: KitElementState & { text?: { text?: string } }): string | undefined =>
  a.text?.text ?? a.selected_option?.text?.text ?? elementValue(a);

/**
 * The message with every `jv:` element taken out and one context line where
 * the first of them stood, saying how it was settled. Anything else - the
 * question, other people's elements - is kept as it was.
 */
export const retireKit = (blocks: readonly KitBlock[], note: string): KitBlock[] => {
  const out: KitBlock[] = [];
  let noted = false;
  const mark = () => {
    if (noted) return;
    noted = true;
    out.push({ type: "context", elements: [{ type: "mrkdwn", text: note }] });
  };
  for (const b of blocks) {
    if (!blockHasKit(b)) {
      out.push(b);
      continue;
    }
    if (b.type === "actions" && Array.isArray(b.elements)) {
      const rest = b.elements.filter((e) => !isKitElement(e));
      if (rest.length) out.push({ ...b, elements: rest });
    } else {
      const { accessory: _gone, ...kept } = b;
      out.push(kept);
    }
    mark();
  }
  return out;
};

export const pressedNote = (userId: string, label: string | undefined): string =>
  `:white_check_mark: <@${userId}> chose${label ? ` *${label}*` : ""}`;

export const repliedNote = (userId: string): string => `:speech_balloon: <@${userId}> answered in the thread`;
