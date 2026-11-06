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
  waitsForButton,
  pickedLabel,
  picksOf,
  retireKit,
  castVote,
  describeVote,
  isSettled,
  isSubmit,
  isVote,
  readVotes,
  voteLines,
  KIT_PATTERN,
  kitRules,
  modalIdOf,
  prepareModal,
  stateLines,
  viewProblem,
  voteSubmitters,
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

  test("only gathering elements beside a live button wait for it", () => {
    const button = { type: "actions", elements: [{ type: "button", action_id: "jv:go" }] };
    expect(waitsForButton("checkboxes", [button])).toBe(true);
    expect(waitsForButton("multi_static_select", [button])).toBe(true);
    expect(waitsForButton("static_select", [button])).toBe(false);
    expect(waitsForButton("checkboxes", [])).toBe(false);
    expect(waitsForButton("checkboxes", [{ type: "actions", elements: [{ type: "button", action_id: "jv:settled:go" }] }])).toBe(false);
    expect(waitsForButton("checkboxes", [{ type: "actions", elements: [{ type: "button", action_id: "jv:modal:x" }] }])).toBe(false);
  });

  test("a press can carry what the message held", () => {
    const text = describeAction({ userId: "U1", actionId: "jv:go", type: "button", state: ["- `b.jv:c`: x"] });
    expect(text).toContain("everything picked on the message");
    expect(text).toContain("- `b.jv:c`: x");
  });

  test("settling keeps our buttons inert, marks the pick and leaves one note", () => {
    const out = retireKit(question, "chose a", "jv:pick-a");
    expect(out).toEqual([
      question[0]!,
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "jv:settled:pick-a", style: "primary", text: { type: "plain_text", text: "✅ a) backup" }, value: "a" },
          { type: "button", action_id: "jv:settled:pick-b", text: { type: "plain_text", text: "b) API" }, value: "b" },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "chose a" }] },
    ]);
    expect(hasLiveKit(question)).toBe(true);
    expect(hasLiveKit(out)).toBe(false);
    expect(isSettled("jv:settled:pick-a")).toBe(true);
    expect(retireKit(out, "again")).toEqual(out);
  });

  test("settling keeps checkboxes in place, inert, with what was ticked", () => {
    const opt = (v: string) => ({ text: { type: "plain_text", text: v.toUpperCase() }, value: v });
    const team = [
      { type: "actions", block_id: "team", elements: [
        { type: "checkboxes", action_id: "jv:team", options: [opt("a"), opt("b"), opt("c")], initial_options: [opt("c")] },
        { type: "multi_users_select", action_id: "jv:who" },
        { type: "button", action_id: "jv:go", text: { type: "plain_text", text: "Go" } },
      ] },
    ];
    const picks = picksOf({ team: {
      "jv:team": { type: "checkboxes", selected_options: [{ value: "a", text: { text: "A" } }, { value: "b" }] },
      "jv:who": { type: "multi_users_select", selected_users: ["U1"] },
    } });
    const [actions] = retireKit(team, "sent", "jv:go", picks);
    const [boxes, who] = (actions as { elements: Record<string, unknown>[] }).elements;
    expect(boxes).toEqual({ type: "checkboxes", action_id: "jv:settled:team", options: [opt("a"), opt("b"), opt("c")], initial_options: [opt("a"), opt("b")] });
    expect(who).toEqual({ type: "multi_users_select", action_id: "jv:settled:who", initial_users: ["U1"] });

    const none = retireKit(team, "sent", "jv:go", picksOf({ team: { "jv:team": { type: "checkboxes", selected_options: [] } } }));
    expect((none[0] as { elements: Record<string, unknown>[] }).elements[0]).not.toHaveProperty("initial_options");
    const kept = retireKit(team, "replied");
    expect((kept[0] as { elements: Record<string, unknown>[] }).elements[0]).toHaveProperty("initial_options", [opt("c")]);
  });

  test("settling without a pick drops colours, and selects of ours go", () => {
    const mixed = [
      { type: "section", text: { type: "mrkdwn", text: "q" }, accessory: { type: "static_select", action_id: "jv:go" } },
      { type: "actions", elements: [{ type: "button", action_id: "approve" }, { type: "button", action_id: "jv:b", style: "danger" }] },
    ];
    const out = retireKit(mixed, "done");
    expect(out).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "q" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "done" }] },
      { type: "actions", elements: [{ type: "button", action_id: "approve" }, { type: "button", action_id: "jv:settled:b" }] },
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

describe("votes wait for submit", () => {
  const vote = [
    { type: "section", text: { type: "mrkdwn", text: "Which one?" } },
    {
      type: "actions",
      block_id: "q1",
      elements: [
        { type: "button", action_id: "jv:q1-a", text: { type: "plain_text", text: "A" }, value: "a" },
        { type: "button", action_id: "jv:q1-b", text: { type: "plain_text", text: "B" }, value: "b" },
      ],
    },
    { type: "actions", block_id: "go", elements: [{ type: "button", action_id: "jv:submit", text: { type: "plain_text", text: "Submit" } }] },
  ];

  test("a submit button makes it a vote, until it is settled", () => {
    expect(isSubmit("jv:submit")).toBe(true);
    expect(isSubmit("jv:submit-quiz")).toBe(true);
    expect(isSubmit("jv:q1-a")).toBe(false);
    expect(isVote(vote)).toBe(true);
    expect(isVote(vote.slice(0, 2))).toBe(false);
    expect(isVote(retireKit(vote, "submitted", "jv:submit"))).toBe(false);
  });

  test("each person has one pick per question, shown under it", () => {
    let blocks = castVote(vote, "q1", "U1", "A");
    blocks = castVote(blocks, "q1", "U2", "B");
    blocks = castVote(blocks, "q1", "U1", "B");
    expect(blocks[2]).toEqual({
      type: "context",
      block_id: "jv-votes:q1",
      elements: [{ type: "mrkdwn", text: ":ballot_box_with_ballot: <@U1> *B*   |   <@U2> *B*" }],
    });
    expect(blocks.length).toBe(vote.length + 1);
    expect([...readVotes(blocks, "q1")]).toEqual([["U1", "B"], ["U2", "B"]]);
  });

  test("pressing your pick again takes it back, and an empty tally goes", () => {
    const once = castVote(vote, "q1", "U1", "A");
    expect(castVote(once, "q1", "U1", "A")).toEqual(vote);
  });

  test("submit hands over every pick", () => {
    const blocks = castVote(castVote(vote, "q1", "U1", "A"), "q1", "U2", "B");
    const lines = voteLines(blocks);
    expect(lines).toEqual(["- block `q1`: <@U1> A, <@U2> B"]);
    const turn = describeVote("U3", "jv:submit", lines);
    expect(turn).toStartWith("[block kit event] <@U3> pressed submit");
    expect(turn).toContain("<@U1> A, <@U2> B");
    expect(describeVote("U3", "jv:submit", [])).toContain("nobody picked");
  });
});

describe("voteSubmitters", () => {
  test("is the thread owner and the last human before the vote, never a bot or a later reply", () => {
    const msgs = [
      { ts: "1.0", user: "UOWNER" },
      { ts: "2.0", user: "UASK" },
      { ts: "2.5", user: "UBOT", bot_id: "B1" },
      { ts: "3.0", user: "UBOT", bot_id: "B1" },
      { ts: "4.0", user: "ULATE" },
    ];
    expect([...voteSubmitters(msgs, "1.0", "3.0")]).toEqual(["UOWNER", "UASK"]);
  });

  test("a bot-opened thread leaves only the person asked", () => {
    const msgs = [{ ts: "1.0", user: "UBOT", bot_id: "B1" }, { ts: "2.0", user: "UASK" }];
    expect([...voteSubmitters(msgs, "1.0", "3.0")]).toEqual(["UASK"]);
  });
});
