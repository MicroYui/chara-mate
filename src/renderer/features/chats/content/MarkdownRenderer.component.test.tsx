import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownRenderer } from "./MarkdownRenderer";

const clipboardWrite = vi.fn<(value: string) => Promise<void>>();

vi.mock("shiki", () => ({
  codeToHtml: vi.fn((code: string) =>
    Promise.resolve(
      `<pre data-testid="highlighted"><code>${code}</code></pre>`,
    ),
  ),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() =>
      Promise.resolve({
        svg: '<svg aria-label="fixture diagram" viewBox="0 0 100 30"></svg>',
      }),
    ),
  },
}));

beforeEach(() => {
  clipboardWrite.mockReset();
  clipboardWrite.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
});

afterEach(() => {
  cleanup();
});

describe("MarkdownRenderer", () => {
  it("renders CJK emphasis beside CJK text without rewriting literal code", () => {
    render(
      <MarkdownRenderer
        source={
          "不算“不热”。明天 **8月9日（周日）**海淀晴天为主，今天*很热（注意）*出门，~~旧安排（取消）~~改成室内。`**代码（原样）**海淀`"
        }
      />,
    );

    expect(
      screen.getByText("8月9日（周日）", { selector: "strong" }),
    ).toBeVisible();
    expect(screen.getByText("很热（注意）", { selector: "em" })).toBeVisible();
    expect(
      screen.getByText("旧安排（取消）", { selector: "del" }),
    ).toBeVisible();
    expect(
      screen.getByText("**代码（原样）**海淀", { selector: "code" }),
    ).toBeVisible();
  });

  it("renders rich content while keeping external links explicit", async () => {
    render(
      <MarkdownRenderer
        source={`## 内容\n\n[文档](https://example.com)\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$E = mc^2$\n\n$$\nL = \\sum_{i=1}^{n} w_i x_i\n$$\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\``}
      />,
    );

    expect(screen.getByRole("heading", { name: "内容" })).toBeVisible();
    expect(screen.getByRole("link", { name: "文档" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByRole("table")).toHaveTextContent("A");
    expect(screen.getByLabelText("ts 代码块")).toHaveTextContent(
      "const answer = 42;",
    );
    const mathCopyButtons = screen.getAllByRole("button", { name: "复制 TeX" });
    expect(mathCopyButtons).toHaveLength(2);
    fireEvent.click(mathCopyButtons[0]!);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith("E = mc^2");
    });
    fireEvent.click(mathCopyButtons[1]!);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenLastCalledWith(
        "L = \\sum_{i=1}^{n} w_i x_i",
      );
    });
    expect(await screen.findByLabelText("fixture diagram")).toBeVisible();
  });

  it("copies the exact code and Markdown table sources", async () => {
    render(
      <MarkdownRenderer
        source={`| 状态 | 数量 |\n| --- | --- |\n| 完成 | 3 |\n\n\`\`\`ts\nconst value = 3;\n\`\`\``}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "复制 Markdown" }));
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith(
        "| 状态 | 数量 |\n| --- | --- |\n| 完成 | 3 |",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenLastCalledWith("const value = 3;");
    });
    expect(screen.getAllByRole("button", { name: "已复制" })).toHaveLength(2);
  });

  it("lets the reader inspect Mermaid source without waiting for rendering", () => {
    render(
      <MarkdownRenderer
        source={`\`\`\`mermaid\nflowchart LR\n  Draft --> Answer\n\`\`\``}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(screen.getByText(/Draft --> Answer/u)).toBeVisible();
  });
});
