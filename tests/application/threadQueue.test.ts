import { describe, expect, test } from "bun:test";
import { createThreadQueue } from "../../src/application/threadQueue.ts";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("createThreadQueue", () => {
  test("a second turn waits for the first instead of running beside it", async () => {
    // the failure this exists for: two messages three minutes apart each did
    // the same work and opened their own pull request for it
    const queue = createThreadQueue();
    const first = deferred<string>();
    const order: string[] = [];

    const a = queue.run("C1:100.1", async () => {
      order.push("a:start");
      const v = await first.promise;
      order.push("a:end");
      return v;
    });
    const b = queue.run("C1:100.1", async () => {
      order.push("b:start");
      return "b";
    });

    // b has not begun while a is still in flight
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    first.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  test("different threads do not wait for each other", async () => {
    const queue = createThreadQueue();
    const held = deferred<string>();
    const slow = queue.run("C1:thread-a", () => held.promise);
    const quick = await queue.run("C1:thread-b", async () => "done");

    expect(quick).toBe("done"); // never blocked on the other thread
    held.resolve("eventually");
    await slow;
  });

  test("a failed turn does not break the chain behind it", async () => {
    // queueing is only better than refusing if the queue survives a failure
    const queue = createThreadQueue();
    const boom = queue.run("C1:100.1", async () => {
      throw new Error("timed out");
    });
    const after = queue.run("C1:100.1", async () => "still ran");

    await expect(boom).rejects.toThrow("timed out");
    expect(await after).toBe("still ran");
  });

  test("depth says whether anything is already running, and settles back to nothing", async () => {
    const queue = createThreadQueue();
    expect(queue.depth("C1:100.1")).toBe(0);

    const held = deferred<string>();
    const a = queue.run("C1:100.1", () => held.promise);
    expect(queue.depth("C1:100.1")).toBe(1);
    const b = queue.run("C1:100.1", async () => "b");
    expect(queue.depth("C1:100.1")).toBe(2);

    held.resolve("a");
    await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 0));
    // an idle bot holds nothing
    expect(queue.depth("C1:100.1")).toBe(0);
  });

  test("turns keep their order", async () => {
    const queue = createThreadQueue();
    const ran: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        queue.run("C1:100.1", async () => {
          await new Promise((r) => setTimeout(r, 5 - n)); // later ones are quicker
          ran.push(n);
        }),
      ),
    );
    expect(ran).toEqual([1, 2, 3, 4]);
  });
});
