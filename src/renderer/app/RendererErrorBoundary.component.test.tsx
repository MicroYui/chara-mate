import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RendererErrorBoundary } from "./RendererErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function BrokenView(): never {
  throw new Error("render failed");
}

describe("Renderer error boundary", () => {
  it("shows recovery actions without exposing a blank window", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <RendererErrorBoundary>
        <BrokenView />
      </RendererErrorBoundary>,
    );

    expect(
      screen.getByRole("heading", {
        name: "CharaMate 的界面遇到了问题",
      }),
    ).toBeVisible();
    expect(screen.getByText("render failed")).toBeInTheDocument();
    expect(screen.getByText("错误详情")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试界面" })).toBeVisible();
    expect(screen.getByRole("button", { name: "重新载入应用" })).toBeVisible();
  });
});
