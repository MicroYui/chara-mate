import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installManagedPageActivity } from "./managedBrowser";

const options = {
  binding: "syntheticActivity",
  batchMs: 1_000,
  maxTextLength: 4_096,
  maxVisitedNodes: 5_000,
};
const host = window as unknown as Record<string, unknown>;
function controller() {
  return host["__charaMateActivity"] as {
    flush(): void;
    stop(): void;
    setAutomated(value: boolean): void;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 30,
    right: 200,
    height: 30,
    width: 200,
    toJSON: () => ({}),
  });
  document.body.innerHTML =
    '<main><h1>研究笔记</h1><p id="content">第一节：对话意图</p><p hidden>不可见草稿</p><input type="password" value="synthetic-password"><textarea>synthetic-input</textarea></main>';
});

afterEach(() => {
  controller()?.stop();
  delete host["syntheticActivity"];
  delete host["__charaMateActivity"];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("managed DOM Activity observation", () => {
  it("publishes visible DOM changes without a URL change and excludes input values", async () => {
    const publish = vi.fn();
    host[options.binding] = publish;
    installManagedPageActivity(options);
    await vi.advanceTimersByTimeAsync(1_000);
    const first: unknown = publish.mock.calls[0]?.[0];
    expect(first).toMatchObject({
      boundary: "content",
      contentStatus: "available",
      content: {
        source: "dom",
        scope: "viewport",
        text: "研究笔记 · 第一节：对话意图",
      },
    });
    expect(JSON.stringify(first)).not.toContain("synthetic-password");
    expect(JSON.stringify(first)).not.toContain("synthetic-input");
    document.querySelector("#content")!.textContent = "第二节：记忆使用";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0]).toMatchObject({
      content: { text: "研究笔记 · 第二节：记忆使用" },
    });
  });

  it("batches an input and mutation flood and cancels timer/listeners on stop", async () => {
    const publish = vi.fn();
    host[options.binding] = publish;
    installManagedPageActivity(options);
    for (let index = 0; index < 10_000; index += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "synthetic-private-key" }),
      );
      if (index % 100 === 0)
        document.querySelector("#content")!.textContent =
          `修订 ${String(index)}`;
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      actor: "user",
      interaction: { clicks: 0, keystrokes: 10_000, scrolls: 0 },
    });
    expect(JSON.stringify(publish.mock.calls)).not.toContain(
      "synthetic-private-key",
    );
    document.dispatchEvent(new Event("wheel"));
    controller().stop();
    document.dispatchEvent(new Event("pointerdown"));
    document.querySelector("#content")!.textContent = "停止后的变化";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("attributes tool-driven changes to Agent and unrelated automatic changes to system", async () => {
    const publish = vi.fn();
    host[options.binding] = publish;
    installManagedPageActivity(options);
    controller().setAutomated(true);
    publish.mockClear();
    document.dispatchEvent(new Event("pointerdown"));
    document.querySelector("#content")!.textContent = "Agent 打开了资料";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      actor: "agent",
      interaction: { clicks: 1 },
    });
    controller().setAutomated(false);
    document.querySelector("#content")!.textContent = "页面自动刷新";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ actor: "system" });
  });

  it("does not label an empty or hidden viewport as readable", async () => {
    document.body.innerHTML = "<canvas></canvas><p hidden>不是 OCR</p>";
    const publish = vi.fn();
    host[options.binding] = publish;
    installManagedPageActivity(options);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      contentStatus: "unavailable",
    });
    expect(publish.mock.calls[0]?.[0]).not.toHaveProperty("content");
  });
});

it("bounds a large DOM excerpt before crossing the page binding", async () => {
  document.body.innerHTML = `<main>${"一段很长的可见资料。".repeat(2_000)}</main>`;
  const publish = vi.fn();
  host[options.binding] = publish;
  installManagedPageActivity(options);
  await vi.advanceTimersByTimeAsync(1_000);
  const observation = publish.mock.calls[0]?.[0] as {
    content: { text: string };
  };
  expect(observation.content.text.length).toBe(4_096);
  expect(publish).toHaveBeenCalledOnce();
});
