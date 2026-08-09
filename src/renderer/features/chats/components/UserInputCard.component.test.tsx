import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserInputResolution } from "../../../../shared/contracts";
import { UserInputCard } from "./UserInputCard";

const input = {
  questions: [
    {
      header: "范围",
      id: "scope",
      options: [
        { description: "只处理当前文件。", label: "当前文件" },
        { description: "处理整个目录。", label: "整个目录" },
      ],
      question: "这次要处理多大范围？",
    },
  ],
};

afterEach(cleanup);

describe("UserInputCard", () => {
  it("submits one structured option and prevents an incomplete answer", () => {
    const onResolve = vi.fn<(resolution: UserInputResolution) => Promise<void>>(
      () => Promise.resolve(),
    );
    render(<UserInputCard input={input} onResolve={onResolve} />);

    const submit = screen.getByRole("button", { name: "提交并继续" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/整个目录/u));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      answers: [
        {
          questionId: "scope",
          value: { kind: "option", label: "整个目录" },
        },
      ],
      status: "answered",
    });
  });

  it("supports free text and an explicit cancellation", () => {
    const onResolve = vi.fn<(resolution: UserInputResolution) => Promise<void>>(
      () => Promise.resolve(),
    );
    const { unmount } = render(
      <UserInputCard input={input} onResolve={onResolve} />,
    );

    fireEvent.click(screen.getByLabelText(/输入更适合你的答案/u));
    fireEvent.change(screen.getByLabelText("范围的其他答案"), {
      target: { value: "仅处理选中的三个文件" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      answers: [
        {
          questionId: "scope",
          value: { kind: "text", text: "仅处理选中的三个文件" },
        },
      ],
      status: "answered",
    });

    onResolve.mockClear();
    unmount();
    render(<UserInputCard input={input} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({ status: "cancelled" });
  });
});
