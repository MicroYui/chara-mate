import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../shared/contracts/foundation";
import { App } from "./App";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-foundation-ready");
});

describe("foundation renderer", () => {
  it("shows the validated runtime snapshot and reports readiness", async () => {
    const markRendererReady = vi.fn();
    const desktopApi: DesktopApi = {
      foundation: {
        getSnapshot: vi.fn().mockResolvedValue({
          appName: "CharaMate",
          appVersion: "0.1.0",
          databaseRoundTrip: true,
          electronVersion: "43.2.0",
          nodeVersion: "24.13.0",
          platform: "darwin",
        }),
        markRendererReady,
      },
    };
    Object.defineProperty(window, "charaMate", {
      configurable: true,
      value: desktopApi,
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "工程基线已就绪" }),
    ).toBeVisible();
    expect(screen.getByTestId("foundation-status")).toHaveTextContent(
      "Electron 43.2.0",
    );
    await waitFor(() => {
      expect(markRendererReady).toHaveBeenCalledOnce();
    });
  });
});
