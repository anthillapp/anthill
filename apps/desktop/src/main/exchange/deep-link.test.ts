import { expect, it, vi } from "vitest";
import { linksFromArgv, workflowIdFromLink, SerialDrain, WorkflowDelivery, WindowOperations } from "./deep-link.js";

it("reads an exact encoded identity, not an arbitrary path or command", () => {
  expect(workflowIdFromLink("anthill://workflow/fix%20startup")).toBe("fix startup");
  for (const value of ["file:///tmp/a", "anthill://workflow/", "anthill://run/x", "anthill://workflow/../x", "anthill://workflow/%2e%2e", "anthill://workflow/a?run=true", "anthill://workflow/a#x", "anthill://workflow/%00", "anthill://workflow/%"]) {
    expect(workflowIdFromLink(value)).toBeUndefined();
  }
  expect(linksFromArgv(["electron", ".", "--data-dir", "/tmp/test", "anthill://workflow/a"])).toEqual(["anthill://workflow/a"]);
});

it("serializes an external open and an async close without bypassing either guard", async () => {
  const queue = new WindowOperations();
  const order: string[] = [];
  let decide!: () => void;
  const open = queue.run(async () => { order.push("ask open"); await new Promise<void>((done) => { decide = done; }); order.push("opened"); });
  const close = queue.run(async () => { order.push("ask close"); });
  await Promise.resolve();
  expect(order).toEqual(["ask open"]);
  decide();
  await open;
  await close;
  expect(order).toEqual(["ask open", "opened", "ask close"]);
});

/*
 * Three things drain the waiting links, and a pass stops in the middle for a
 * dialog. Two passes over the same set opened one link twice and asked about a
 * declined one a second time; a bare in-flight flag would instead leave a link
 * that arrived mid-pass waiting for the next event to come along.
 */
it("runs one pass at a time and runs again for whatever arrived during one", async () => {
  const waiting = new Set(["first"]);
  const handled: string[] = [];
  let overlaps = 0;
  let inside = false;
  let answer!: () => void;
  const dialog = new Promise<void>((done) => { answer = done; });
  const drain = new SerialDrain(async () => {
    if (inside) overlaps += 1;
    inside = true;
    for (const item of [...waiting]) {
      waiting.delete(item);
      handled.push(item);
      if (item === "first") await dialog;
    }
    inside = false;
  });

  const first = drain.run();
  // A second link arrives while the question about the first is on screen, and
  // asks for a drain of its own.
  waiting.add("second");
  const second = drain.run();
  answer();
  await Promise.all([first, second]);

  expect(handled).toEqual(["first", "second"]);
  expect(overlaps).toBe(0);
});

it("requires the matching renderer acknowledgement and does not remount a duplicate", async () => {
  const delivery = new WorkflowDelivery();
  const send = vi.fn((_id: number) => true);
  const result = delivery.deliver("/workflow.json", send);
  const id = send.mock.calls[0]![0];
  delivery.acknowledge("/different.json", id);
  delivery.acknowledge("/workflow.json", id);
  expect(await result).toBe("shown");
  expect(await delivery.deliver("/workflow.json", send)).toBe("shown");
  expect(send).toHaveBeenCalledTimes(1);
  delivery.reset();
  expect(await delivery.deliver("/workflow.json", send, 1)).toBe("unconfirmed");
});

it("leaves an unacknowledged delivery pending when the window closes", async () => {
  const delivery = new WorkflowDelivery();
  const result = delivery.deliver("/workflow.json", () => true);
  delivery.reset();
  expect(await result).toBe("unconfirmed");
});

it("answers at once when there was no page to send to, rather than waiting out the timeout", async () => {
  const delivery = new WorkflowDelivery();
  const started = Date.now();
  expect(await delivery.deliver("/workflow.json", () => false, 60_000)).toBe("parked");
  expect(Date.now() - started).toBeLessThan(1_000);
});

it("serializes distinct targets and ignores an old acknowledgement after timeout", async () => {
  const delivery = new WorkflowDelivery();
  const send = vi.fn((_id: number) => true);
  const stale = delivery.deliver("/first.json", send, 1);
  const current = delivery.deliver("/second.json", send, 60_000);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await stale).toBe("unconfirmed");
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(2);
  delivery.acknowledge("/first.json", send.mock.calls[0]![0]);
  expect(delivery.currentPath).toBeUndefined();
  delivery.acknowledge("/second.json", send.mock.calls[1]![0]);
  expect(await current).toBe("shown");
});

it("coalesces the same path before acknowledgement for inbox and deep-link callers", async () => {
  const delivery = new WorkflowDelivery();
  const send = vi.fn((_id: number) => true);
  const first = delivery.deliver("/workflow.json", send);
  const second = delivery.deliver("/workflow.json", send);
  expect(second).toBe(first);
  expect(send).toHaveBeenCalledTimes(1);
  delivery.acknowledge("/workflow.json", send.mock.calls[0]![0]);
  expect(await Promise.all([first, second])).toEqual(["shown", "shown"]);
});

it("a declined navigation does not change the open path and can be requested again", async () => {
  const delivery = new WorkflowDelivery();
  delivery.acknowledge("/original.json");
  const send = vi.fn((_id: number) => true);
  const first = delivery.deliver("/new.json", send);
  delivery.acknowledge("/new.json", send.mock.calls[0]![0], "declined");
  expect(await first).toBe("declined");
  expect(delivery.currentPath).toBe("/original.json");
  const retry = delivery.deliver("/new.json", send);
  delivery.acknowledge("/new.json", send.mock.calls[1]![0]);
  expect(await retry).toBe("shown");
});

it("reset cancels queued deliveries and old acknowledgements cannot settle a retry", async () => {
  const delivery = new WorkflowDelivery();
  const send = vi.fn((_id: number) => true);
  const first = delivery.deliver("/first.json", send);
  const second = delivery.deliver("/second.json", send);
  const staleId = send.mock.calls[0]![0];
  delivery.reset();
  expect(await Promise.all([first, second])).toEqual(["unconfirmed", "unconfirmed"]);
  expect(send).toHaveBeenCalledTimes(1);
  const retry = delivery.deliver("/first.json", send);
  delivery.acknowledge("/first.json", staleId);
  expect(delivery.currentPath).toBeUndefined();
  delivery.acknowledge("/first.json", send.mock.calls[1]![0]);
  expect(await retry).toBe("shown");
});

it("does not hold window operations while a navigation awaits the page", async () => {
  const queue = new WindowOperations();
  const delivery = new WorkflowDelivery();
  const send = vi.fn((_id: number) => true);
  const opening = delivery.deliver("/workflow.json", send);
  expect(await queue.run(async () => "close was checked")).toBe("close was checked");
  delivery.reset();
  expect(await opening).toBe("unconfirmed");
});

it("does not time out a human decision, but resumes the timeout when opening", async () => {
  vi.useFakeTimers();
  try {
    const delivery = new WorkflowDelivery();
    const send = vi.fn((_id: number) => true);
    const first = delivery.deliver("/first.json", send, 10);
    const second = delivery.deliver("/second.json", send, 10);
    const id = send.mock.calls[0]![0];
    delivery.acknowledge("/first.json", id, "confirming");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(delivery.currentPath).toBeUndefined();
    delivery.acknowledge("/first.json", id, "opening");
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toBe("unconfirmed");
    expect(send).toHaveBeenCalledTimes(2);
    delivery.reset();
    expect(await second).toBe("unconfirmed");
  } finally { vi.useRealTimers(); }
});
