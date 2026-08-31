import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messageFixture } from "../../../../../tests/fixtures/foundationContracts";
import { MessageItem } from "./MessageList";

const clipboardWrite = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
  clipboardWrite.mockReset();
  clipboardWrite.mockResolvedValue(undefined);
  Object.defineProperty(window, "charaMate", {
    configurable: true,
    value: { clipboard: { writeText: clipboardWrite } },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "charaMate");
});

describe("MessageItem", () => {
  it("copies the exact source and requests editing for a user message", async () => {
    const onEditUserMessage = vi.fn();
    render(
      <MessageItem
        onEditUserMessage={onEditUserMessage}
        value={{ attachments: [], record: messageFixture }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith(messageFixture.content);
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }));
    expect(onEditUserMessage).toHaveBeenCalledWith(messageFixture.content);
  });
});
