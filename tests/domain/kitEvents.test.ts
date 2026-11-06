import { describe, expect, test } from "bun:test";
import {
  decodeKitMeta,
  describeAction,
  describeClosed,
  describeSubmission,
  elementValue,
  encodeKitMeta,
  hasLiveKit,
  locksOnPress,
  pickedLabel,
  retireKit,
  KIT_PATTERN,
  kitRules,
  modalIdOf,
  prepareModal,
  stateLines,
  viewProblem,
} from "../../src/domain/kitEvents.ts";

const thread = { channelId: "C1", threadTs: "100.1" };

describe("which ids are the brain's", () => {
  test("only jv: ids are caught, so built-in buttons keep their own listeners", () => {
    expect(KIT_PATTERN.test("jv:approve")).toBe(true);
    expect(KIT_PATTERN.test("command_approve")).toBe(false);
    expect(KIT_PATTERN.test("command_menu_run:review")).toBe(false);
  });

  test("a jv:modal: id names a stored view, anything else does not", () => {
    expect(modalIdOf("jv:modal:abc123")).toBe("abc123");
    expect(modalIdOf("jv:modal:")).toBeUndefined();
    expect(modalIdOf("jv:approve")).toBeUndefined();
  });
});

describe("routing a modal back to its thread", () => {
  test("metadata round-trips the thread and the model's own value", () => {
    expect(decodeKitMeta(encodeKitMeta(thread, "refund-42"))).toEqual({ thread, own: "refund-42" });
    expect(decodeKitMeta(encodeKitMeta(thread))).toEqual({ thread, own: undefined });
  });

  test("metadata it did not write routes nowhere instead of throwing", () => {
    expect(decodeKitMeta("not json")).toEqual({});
    expect(decodeKitMeta(undefined)).toEqual({});
    expect(decodeKitMeta('{"c":"C1"}').thread).toBeUndefined();
  });

  test("a stored view gets a jv: callback id and the thread, keeping its own metadata", () => {
    const view = prepareModal(
      { title: { type: "plain_text", text: "Ticket" }, blocks: [], private_metadata: "t-9" },
      "abc",
      thread,
    );
    expect(view.type).toBe("modal");
    expect(view.callback_id).toBe("jv:view:abc");
    expect(decodeKitMeta(view.private_metadata as string)).toEqual({ thread, own: "t-9" });
  });

  test("a jv: callback id the model chose is kept, any other is replaced", () => {
    expect(prepareModal({ callback_id: "jv:ticket", blocks: [] }, "a", thread).callback_id).toBe("jv:ticket");
    expect(prepareModal({ callback_id: "ticket", blocks: [] }, "a", thread).callback_id).toBe("jv:view:a");
  });

  test("metadata too long for Slack drops the model's part, never the thread", () => {
    const view = prepareModal({ blocks: [], private_metadata: "x".repeat(3500) }, "a", thread);
    expect(decodeKitMeta(view.private_metadata as string)).toEqual({ thread, own: undefined });
  });
});

describe("checking a view before storing it", () => {
  const ok = { type: "modal", title: { type: "plain_text", text: "T" }, blocks: [] };
  test("a modal with a title and blocks is fine", () => {
    expect(viewProblem(ok)).toBeUndefined();
    expect(viewProblem({ ...ok, type: undefined })).toBeUndefined();
  });
  test("anything that could not open says why", () => {
    expect(viewProblem("x")).toContain("object");
    expect(viewProblem({ ...ok, type: "home" })).toContain("modal");
    expect(viewProblem({ ...ok, blocks: undefined })).toContain("blocks");
    expect(viewProblem({ ...ok, title: undefined })).toContain("title");
  });
});

describe("reading what an element holds", () => {
  test("every element type comes out as text", () => {
    expect(elementValue({ type: "button", value: "yes" })).toBe("yes");
    expect(elementValue({ type: "static_select", selected_option: { value: "p1" } })).toBe("p1");
    expect(elementValue({ type: "checkboxes", selected_options: [{ value: "a" }, { value: "b" }] })).toBe("a, b");
    expect(elementValue({ type: "datepicker", selected_date: "2026-11-06" })).toBe("2026-11-06");
    expect(elementValue({ type: "timepicker", selected_time: "09:30" })).toBe("09:30");
    expect(elementValue({ type: "users_select", selected_user: "U1" })).toBe("<@U1>");
    expect(elementValue({ type: "multi_users_select", selected_users: ["U1", "U2"] })).toBe("<@U1>, <@U2>");
    expect(elementValue({ type: "channels_select", selected_channel: "C1" })).toBe("<#C1>");
    expect(elementValue({ type: "conversations_select", selected_conversation: "C2" })).toBe("<#C2>");
    expect(elementValue({ type: "datetimepicker", selected_date_time: 0 })).toBe("1970-01-01T00:00:00.000Z");
    expect(
      elementValue({
        type: "rich_text_input",
        rich_text_value: { elements: [{ elements: [{ text: "hi " }, { user_id: "U1" }] }] },
      }),
    ).toBe("hi <@U1>");
  });

  test("nothing picked is undefined, and shows as empty in a submission", () => {
    expect(elementValue({ type: "static_select", selected_option: null })).toBeUndefined();
    expect(stateLines({ b1: { a1: { type: "plain_text_input", value: null } } })).toEqual(["- `b1.a1`: _(empty)_"]);
  });
});

describe("what the turn says", () => {
  test("a press names who, what and the value", () => {
    const text = describeAction({ userId: "U1", actionId: "jv:approve", type: "button", value: "refund-42" });
    expect(text).toStartWith("[block kit event] <@U1> used `jv:approve` (button)");
    expect(text).toContain("on a message in this thread");
    expect(text).toContain("`refund-42`");
  });

  test("a press inside a modal says which", () => {
    expect(describeAction({ userId: "U1", actionId: "jv:x", inModal: "Ticket" })).toContain('inside the modal "Ticket"');
  });

  test("a submission lists every field", () => {
    const text = describeSubmission({
      userId: "U1",
      callbackId: "jv:view:a",
      title: "Ticket app",
      own: "t-9",
      fields: stateLines({ title: { input: { value: "login broken" } }, sev: { pick: { selected_option: { value: "high" } } } }),
    });
    expect(text).toContain('submitted the modal "Ticket app"');
    expect(text).toContain("`t-9`");
    expect(text).toContain("- `title.input`: login broken");
    expect(text).toContain("- `sev.pick`: high");
  });

  test("a cancel says it was closed", () => {
    expect(describeClosed({ userId: "U1", callbackId: "jv:view:a" })).toContain("closed the modal");
  });
});

describe("the prompt rules", () => {
  test("offered only with somewhere to store a modal, and naming it", () => {
    expect(kitRules("")).toBe("");
    const rules = kitRules("http://127.0.0.1:2002/api/kit/views");
    expect(rules).toContain("http://127.0.0.1:2002/api/kit/views");
    expect(rules).toContain('"jv:"');
    expect(rules).toContain("thread_ts");
  });
});

describe("answered questions lock", () => {
  const question = [
    { type: "section", text: { type: "mrkdwn", text: "Which one?" } },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: "jv:pick-a", text: { type: "plain_text", text: "a) backup" }, value: "a" },
        { type: "button", action_id: "jv:pick-b", text: { type: "plain_text", text: "b) API" }, value: "b" },
      ],
    },
  ];

  test("single-shot presses lock, multi-selects and modal openers do not", () => {
    expect(locksOnPress("button", "jv:pick-a")).toBe(true);
    expect(locksOnPress("static_select", "jv:x")).toBe(true);
    expect(locksOnPress("checkboxes", "jv:x")).toBe(false);
    expect(locksOnPress("multi_static_select", "jv:x")).toBe(false);
    expect(locksOnPress("button", "jv:modal:abc")).toBe(false);
    expect(locksOnPress(undefined, "jv:x")).toBe(false);
  });

  test("retiring drops our elements, keeps the question and leaves one note", () => {
    const out = retireKit(question, "chose a");
    expect(out).toEqual([question[0]!, { type: "context", elements: [{ type: "mrkdwn", text: "chose a" }] }]);
    expect(hasLiveKit(question)).toBe(true);
    expect(hasLiveKit(out)).toBe(false);
  });

  test("elements that are not ours stay, and an accessory of ours goes", () => {
    const mixed = [
      { type: "section", text: { type: "mrkdwn", text: "q" }, accessory: { type: "button", action_id: "jv:go" } },
      { type: "actions", elements: [{ type: "button", action_id: "approve" }, { type: "button", action_id: "jv:b" }] },
    ];
    const out = retireKit(mixed, "done");
    expect(out).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "q" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "done" }] },
      { type: "actions", elements: [{ type: "button", action_id: "approve" }] },
    ]);
    expect(hasLiveKit(undefined)).toBe(false);
  });

  test("the picked label is what the person saw", () => {
    expect(pickedLabel({ type: "button", value: "a", text: { text: "a) backup" } })).toBe("a) backup");
    expect(pickedLabel({ selected_option: { value: "p1", text: { text: "Plan 1" } } })).toBe("Plan 1");
    expect(pickedLabel({ value: "v" })).toBe("v");
  });

  test("the brain is told to ask choices with buttons", () => {
    expect(kitRules("http://x")).toContain("asked with buttons");
  });
});
