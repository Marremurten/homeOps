import { describe, it, expect } from "vitest";
import { isTextMessage } from "@shared/types/telegram.js";

describe("isTextMessage type guard", () => {
  it("returns true for a valid text message update", () => {
    const update = {
      update_id: 12345,
      message: {
        message_id: 1,
        date: 1234567890,
        chat: { id: -100123, type: "group", title: "Test" },
        from: { id: 111, is_bot: false, first_name: "Test" },
        text: "Hello world",
      },
    };

    expect(isTextMessage(update)).toBe(true);
  });

  it("returns false for an edited_message update", () => {
    const update = {
      update_id: 12346,
      edited_message: {
        message_id: 1,
        date: 1234567890,
        edit_date: 1234567899,
        chat: { id: -100123, type: "group", title: "Test" },
        from: { id: 111, is_bot: false, first_name: "Test" },
        text: "Edited text",
      },
    };

    expect(isTextMessage(update)).toBe(false);
  });

  it("returns false for a callback_query update", () => {
    const update = {
      update_id: 12347,
      callback_query: {
        id: "abc123",
        from: { id: 111, is_bot: false, first_name: "Test" },
        chat_instance: "instance",
        data: "button_click",
      },
    };

    expect(isTextMessage(update)).toBe(false);
  });

  it("returns false for an empty update object (only update_id)", () => {
    const update = {
      update_id: 12348,
    };

    expect(isTextMessage(update)).toBe(false);
  });

  it("returns false for an update with a message that has no text field (photo message)", () => {
    const update = {
      update_id: 12349,
      message: {
        message_id: 2,
        date: 1234567890,
        chat: { id: -100123, type: "group", title: "Test" },
        from: { id: 111, is_bot: false, first_name: "Test" },
        photo: [{ file_id: "abc", file_unique_id: "def", width: 100, height: 100 }],
      },
    };

    expect(isTextMessage(update)).toBe(false);
  });
});
