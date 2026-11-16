import { describe, expect, test } from "bun:test";
import { applySelfPostCall, closingReply, createKeepMarkerFilter, hasKeepMarker, KEEP_REPLY, stripKeepMarker, type SelfPost } from "../../src/domain/selfPost.ts";

const posted: SelfPost[] = [{ ts: "9.1" }];

const VI_POST =
  "dạ stuck thật anh :man-bowing::skin-tone-2: sub agent Fable cũ chết theo turn hôm đó, 2h21m không branch, không PR. lỗi của em: chỉ watch file kết quả, không watch con agent nên nó chết mà không ai biết\n- đã chạy lại Fable dạng process riêng, không chết theo turn nữa\n- 2 watch: một cái báo khi bài xong, một cái báo ngay nếu writer chết giữa chừng\n- lỗ này nằm ở skill blog, em đã gửi bug report #4 để anh duyệt sửa\nxong em gửi tiêu đề, PR, ảnh diagram + nút Publish/Revise vào thread này, tối đa 3 tiếng :coffee:";
// Captured from a real thread: the reword adds function words and one sentence about the post itself.
const VI_REPLY =
  "Dạ stuck thật anh :man-bowing::skin-tone-2: Sub agent Fable cũ chết theo turn hôm đó. Sau 2h21m vẫn không có branch, không có PR nào. Lỗi của em: em chỉ watch file kết quả, không watch chính con agent, nên nó chết mà không ai biết. Em cập nhật hết trong message em đã post ở thread này rồi.  - em đã chạy lại Fable thành một process riêng, lần này không chết theo turn nữa - có 2 watch: một cái báo khi bài xong, một cái báo ngay nếu writer chết giữa chừng - lỗ này nằm ở skill blog, em đã gửi bug report #4 chờ anh duyệt sửa  Bài xong em gửi vào thread này tiêu đề, link PR, ảnh diagram và nút Publish/Revise, tối đa 3 tiếng :coffee:";

describe("closingReply", () => {
  test("the real Vietnamese reword after a self-post is dropped", () => {
    expect(VI_POST.length).toBeGreaterThan(0);
    expect(closingReply(VI_REPLY, posted)).toEqual({ kind: "drop" });
  });
  test("a correction without the marker is dropped too: the accepted trade-off", () => {
    expect(closingReply("Correction: staging is NOT green.", posted)).toEqual({ kind: "drop" });
  });
  test("with the marker line it is sent, the marker stripped", () => {
    expect(closingReply(`${KEEP_REPLY}\nCorrection: staging is NOT green.`, posted)).toEqual({ kind: "send", text: "Correction: staging is NOT green." });
    expect(closingReply(`Correction: staging is NOT green.\n\n  ${KEEP_REPLY}  \n`, posted)).toEqual({ kind: "send", text: "Correction: staging is NOT green." });
  });
  test("a turn with no self-post sends its reply as it is, and the marker never goes out", () => {
    expect(closingReply("All done.", [])).toEqual({ kind: "send", text: "All done." });
    expect(closingReply(`${KEEP_REPLY}\nx`, [])).toEqual({ kind: "send", text: "x" });
  });
  test("a reply that is only the marker is dropped, posts or not", () => {
    expect(closingReply(KEEP_REPLY, posted)).toEqual({ kind: "drop" });
    expect(closingReply(` ${KEEP_REPLY} \n`, [])).toEqual({ kind: "drop" });
  });
});

describe("the marker", () => {
  test("is a line of its own, not a word inside a sentence", () => {
    expect(hasKeepMarker(`done\n${KEEP_REPLY}`)).toBe(true);
    expect(hasKeepMarker(`I will not write ${KEEP_REPLY} here`)).toBe(false);
    expect(hasKeepMarker("keep_reply")).toBe(false);
    expect(stripKeepMarker(`a\n${KEEP_REPLY}\nb`)).toBe("a\nb");
  });
});

describe("applySelfPostCall", () => {
  const ok = (ts: string) => JSON.stringify({ ok: true, ts });
  const inThread = { channel: "C1", thread_ts: "1.1", text: "first answer" };

  test("a successful post into the turn's thread is recorded", () => {
    expect(applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: ok("5.5") }, "1.1")).toEqual([{ ts: "5.5" }]);
  });
  test("a failed post, a top-level post and a post into another thread are not", () => {
    const failed = JSON.stringify({ ok: false, error: "channel_not_found" });
    expect(applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: failed }, "1.1")).toEqual([]);
    expect(applySelfPostCall([], { method: "chat.postMessage", params: { channel: "C1", text: "x" }, answer: ok("5.5") }, "1.1")).toEqual([]);
    expect(applySelfPostCall([], { method: "chat.postMessage", params: { ...inThread, thread_ts: "2.2" }, answer: ok("5.5") }, "1.1")).toEqual([]);
    expect(applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: "<html>" }, "1.1")).toEqual([]);
  });
  test("a turn with no thread records nothing", () => {
    expect(applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: ok("5.5") }, undefined)).toEqual([]);
  });
  test("an update of a message the turn posted counts; any other ts does not", () => {
    const first = applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: ok("5.5") }, "1.1");
    const updated = applySelfPostCall(first, { method: "chat.update", params: { channel: "C1", ts: "5.5", text: "final" }, answer: ok("5.5") }, "1.1");
    expect(updated).toEqual([{ ts: "5.5" }]);
    expect(applySelfPostCall(updated, { method: "chat.update", params: { channel: "C1", ts: "7.7", text: "x" }, answer: ok("7.7") }, "1.1")).toBe(updated);
  });
});

describe("createKeepMarkerFilter", () => {
  const run = (chunks: string[]): string => {
    const f = createKeepMarkerFilter();
    return chunks.map(f.push).join("") + f.flush();
  };
  test("drops the marker as its own chunk, after a line, or split in pieces", () => {
    expect(run(["Correction.\n", KEEP_REPLY])).toBe("Correction.\n");
    expect(run([`Correction.\n${KEEP_REPLY}`])).toBe("Correction.\n");
    expect(run(["Correction.\nKEEP_", "REPL", "Y"])).toBe("Correction.\n");
    expect(run(["KEEP_REPLY\n", "text"])).toBe("text");
    expect(run(["a\n  KEEP", "_REPLY  \nb"])).toBe("a\nb");
    expect(run(["a\r\nKEEP_REPLY\r\nb"])).toBe("a\r\nb");
  });
  test("holds a trailing partial only while it could still be the marker", () => {
    const f = createKeepMarkerFilter();
    expect(f.push("ok\nKEEP_")).toBe("ok\n");
    expect(f.push("REPLX")).toBe("KEEP_REPLX");
    expect(f.push(" and more")).toBe(" and more");
    expect(f.flush()).toBe("");
  });
  test("releases a held line that never became the marker at the end", () => {
    expect(run(["ok\nKEEP"])).toBe("ok\nKEEP");
    expect(run(["ok\nKEEP_REPLY and more"])).toBe("ok\nKEEP_REPLY and more");
  });
  test("text with the token inside a sentence passes whole", () => {
    expect(run(["I will not write KEEP_REPLY here"])).toBe("I will not write KEEP_REPLY here");
    expect(run(["a", "b ", "c\n", "d"])).toBe("ab c\nd");
  });
});
