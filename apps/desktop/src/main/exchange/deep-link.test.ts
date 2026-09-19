import { expect, it, vi } from "vitest";
import { linksFromArgv, workflowIdFromLink, WorkflowDelivery, WindowOperations } from "./deep-link.js";

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

it("requires the matching renderer acknowledgement and does not remount a duplicate", async () => {
  const delivery = new WorkflowDelivery();
  const send = vi.fn();
  const result = delivery.deliver("/workflow.json", send);
  delivery.acknowledge("/different.json");
  delivery.acknowledge("/workflow.json");
  expect(await result).toBe(true);
  expect(await delivery.deliver("/workflow.json", send)).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  delivery.reset();
  expect(await delivery.deliver("/workflow.json", send, 1)).toBe(false);
});

it("leaves an unacknowledged delivery pending when the window closes", async () => {
  const delivery = new WorkflowDelivery();
  const result = delivery.deliver("/workflow.json", () => undefined);
  delivery.reset();
  expect(await result).toBe(false);
});
