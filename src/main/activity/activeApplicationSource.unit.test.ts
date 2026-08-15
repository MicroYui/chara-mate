import { describe, expect, it } from "vitest";

import { parseActiveApplicationEvent } from "./activeApplicationSource";

describe("active application event parsing", () => {
  it("accepts the bounded native helper payload", () => {
    expect(
      parseActiveApplicationEvent(
        JSON.stringify({
          appId: "com.example.editor",
          appName: "Editor",
          windowTitle: "draft.md",
        }),
      ),
    ).toEqual({
      appId: "com.example.editor",
      appName: "Editor",
      windowTitle: "draft.md",
    });
  });

  it("rejects malformed or nameless events", () => {
    expect(parseActiveApplicationEvent("not-json")).toBeUndefined();
    expect(
      parseActiveApplicationEvent('{"windowTitle":"draft.md"}'),
    ).toBeUndefined();
  });
});
