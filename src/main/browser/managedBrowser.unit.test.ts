import { describe, expect, it, vi } from "vitest";

import type { ArtifactStore } from "../tools/artifactStore";
import { ToolRegistry } from "../tools/toolRegistry";
import { type ManagedBrowser, registerBrowserTools } from "./managedBrowser";

describe("managed Browser Tools", () => {
  it("does not report an empty browser page as a successful snapshot", async () => {
    const browser = {
      run: (_signal: AbortSignal, action: (page: unknown) => unknown) =>
        Promise.resolve(action({ url: () => "about:blank" })),
    } as unknown as ManagedBrowser;
    const presentText = vi.fn();
    const artifacts = {
      presentText,
    } as unknown as ArtifactStore;
    const tools = new ToolRegistry();
    registerBrowserTools(tools, browser, artifacts);

    await expect(
      tools.execute(
        "browser.snapshot",
        {},
        {
          itemId: "item-browser-snapshot",
          onDelta: vi.fn(),
          runId: "run-browser-snapshot",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow("当前没有可读取的网页");
    expect(presentText).not.toHaveBeenCalled();
  });
});
