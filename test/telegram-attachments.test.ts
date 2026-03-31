/**
 * Telegram attachment types — comprehensive test suite.
 *
 * Tests all Telegram message types handled by the transport layer:
 *
 * Receiving (dispatchUpdate):
 * - video_note (round video), animation (GIF), location, venue, contact,
 *   poll, dice, edited_message, callback_query, reply_to_message, forward_from
 *
 * Receiving (handleFileMessage):
 * - video_note and animation file download + forwarding
 *
 * Sending (send):
 * - sendAnimation (GIF), sendVideoNote, sendLocation, sendVenue, sendContact,
 *   sendPoll, sendMediaGroup, sendSticker, editMessageText, deleteMessage,
 *   answerCallbackQuery, threading (reply_to_message_id)
 *
 * New transport methods:
 * - sendLocation, sendVenue, sendContact, sendPoll, sendAnimation,
 *   sendVideoNote, sendSticker, sendMediaGroup, deleteMessage,
 *   answerCallbackQuery
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTelegramTransport } from "../dist/transports/telegram.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTestAdapter(opts: Record<string, unknown> = {}) {
  return createTelegramTransport({
    botToken: "test-token-123",
    sendOnly: true,
    ...opts,
  });
}

function makeFetchOk() {
  return new Response(JSON.stringify({ ok: true, result: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a mock fetch that routes Telegram API calls */
function mockTelegramFetch(fetchSpy: ReturnType<typeof vi.spyOn>, fetchCalls: string[]) {
  fetchSpy.mockImplementation(async (url: any, _init?: any) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    fetchCalls.push(urlStr);

    if (urlStr.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "files/test.bin" } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("api.telegram.org/file/")) {
      return new Response(Buffer.from("fake-file-data"), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    return makeFetchOk();
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Telegram attachment types", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RECEIVING: dispatchUpdate — new message types
  // ═══════════════════════════════════════════════════════════════════════════

  describe("dispatchUpdate: location messages", () => {
    it("dispatches location as chat with lat/lng in meta", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      await adapter.connect("telegram://100", (msg) => received.push(msg));

      // Simulate location update via dispatchUpdate
      const target = (adapter as any).transports.get("100");
      // Call dispatchUpdate directly
      (adapter as any).dispatchUpdate({
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: 100 },
          from: { id: 1, username: "alice" },
          location: { latitude: 37.7749, longitude: -122.4194 },
        },
      });

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.type).toBe("chat");
      expect(msg.content).toContain("Location");
      expect(msg.content).toContain("37.7749");
      expect(msg.meta.latitude).toBe("37.7749");
      expect(msg.meta.longitude).toBe("-122.4194");

      await adapter.close();
    });
  });

  describe("dispatchUpdate: venue messages", () => {
    it("dispatches venue with title, address, and coordinates", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://101", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 2,
        message: {
          message_id: 11,
          chat: { id: 101 },
          from: { id: 2, username: "bob" },
          venue: {
            title: "Golden Gate Park",
            address: "San Francisco, CA",
            location: { latitude: 37.7694, longitude: -122.4862 },
          },
          // venue implies location is also present
          location: { latitude: 37.7694, longitude: -122.4862 },
        },
      });

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.content).toContain("Venue");
      expect(msg.content).toContain("Golden Gate Park");
      expect(msg.meta.venue_title).toBe("Golden Gate Park");
      expect(msg.meta.venue_address).toBe("San Francisco, CA");

      await adapter.close();
    });
  });

  describe("dispatchUpdate: contact messages", () => {
    it("dispatches contact with name and phone number", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://102", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 3,
        message: {
          message_id: 12,
          chat: { id: 102 },
          from: { id: 3, username: "carol" },
          contact: {
            phone_number: "+15551234567",
            first_name: "Dave",
            last_name: "Smith",
          },
        },
      });

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.content).toContain("Contact");
      expect(msg.content).toContain("Dave Smith");
      expect(msg.meta.phone_number).toBe("+15551234567");
      expect(msg.meta.contact_first_name).toBe("Dave");
      expect(msg.meta.contact_last_name).toBe("Smith");

      await adapter.close();
    });
  });

  describe("dispatchUpdate: poll messages", () => {
    it("dispatches poll with question and options", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://103", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 4,
        message: {
          message_id: 13,
          chat: { id: 103 },
          from: { id: 4, username: "eve" },
          poll: {
            question: "Favorite color?",
            options: [
              { text: "Red", voter_count: 0 },
              { text: "Blue", voter_count: 0 },
              { text: "Green", voter_count: 0 },
            ],
          },
        },
      });

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.content).toContain("Poll");
      expect(msg.content).toContain("Favorite color?");
      expect(msg.meta.poll_question).toBe("Favorite color?");
      const opts = JSON.parse(msg.meta.poll_options);
      expect(opts).toEqual(["Red", "Blue", "Green"]);

      await adapter.close();
    });
  });

  describe("dispatchUpdate: dice messages", () => {
    it("dispatches dice with emoji and value", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://104", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 5,
        message: {
          message_id: 14,
          chat: { id: 104 },
          from: { id: 5, username: "frank" },
          dice: { emoji: "\u{1F3B2}", value: 4 },
        },
      });

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.content).toContain("Dice");
      expect(msg.content).toContain("4");
      expect(msg.meta.dice_value).toBe("4");

      await adapter.close();
    });
  });

  describe("dispatchUpdate: callback_query (button clicks)", () => {
    it("dispatches callback query with data and original message info", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://105", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 6,
        callback_query: {
          id: "cb-query-123",
          data: "action:approve",
          from: { id: 6, username: "grace" },
          message: {
            message_id: 50,
            chat: { id: 105 },
            text: "Do you approve?",
          },
        },
      });

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.type).toBe("chat");
      expect(msg.content).toBe("action:approve");
      expect(msg.from).toBe("grace");
      expect(msg.meta.callback_query_id).toBe("cb-query-123");
      expect(msg.meta.callback_data).toBe("action:approve");
      expect(msg.meta.original_message_id).toBe("50");
      expect(msg.meta.original_message_text).toBe("Do you approve?");

      await adapter.close();
    });

    it("auto-answers callback query to dismiss loading indicator", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      await adapter.connect("telegram://105", () => {});

      (adapter as any).dispatchUpdate({
        update_id: 7,
        callback_query: {
          id: "cb-auto-answer",
          data: "some:action",
          from: { id: 7, username: "heidi" },
          message: { message_id: 51, chat: { id: 105 } },
        },
      });

      // Wait for the auto-answer promise to settle
      await new Promise((r) => setTimeout(r, 50));

      const answerCall = fetchCalls.find((u) => u.includes("/answerCallbackQuery"));
      expect(answerCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("dispatchUpdate: edited_message", () => {
    it("dispatches edited text message with edited flag in meta", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://106", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 8,
        edited_message: {
          message_id: 20,
          chat: { id: 106 },
          from: { id: 8, username: "ivan" },
          text: "Updated text content",
          edit_date: 1700000001,
        },
      });

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.type).toBe("chat");
      expect(msg.content).toBe("Updated text content");
      expect(msg.meta.edited).toBe("true");

      await adapter.close();
    });
  });

  describe("dispatchUpdate: reply_to_message", () => {
    it("includes reply context in meta for text messages", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://107", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 9,
        message: {
          message_id: 30,
          chat: { id: 107 },
          from: { id: 9, username: "judy" },
          text: "This is a reply",
          reply_to_message: {
            message_id: 25,
            from: { id: 10, username: "karl" },
            text: "Original message here",
          },
        },
      });

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.content).toContain("This is a reply");
      expect(msg.content).toContain("↩");
      expect(msg.content).toContain("karl");
      expect(msg.meta.reply_to_id).toBe("25");
      expect(msg.meta.reply_to_user).toBe("karl");
      expect(msg.meta.reply_to_text).toBe("Original message here");

      await adapter.close();
    });
  });

  describe("dispatchUpdate: forward_from", () => {
    it("includes forward source in meta", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://108", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 10,
        message: {
          message_id: 35,
          chat: { id: 108 },
          from: { id: 11, username: "lisa" },
          text: "Forwarded content",
          forward_from: { id: 12, username: "mike" },
        },
      });

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.content).toContain("Forwarded content");
      expect(msg.content).toContain("⤳");
      expect(msg.content).toContain("mike");
      expect(msg.meta.forwarded_from).toBe("mike");

      await adapter.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RECEIVING: handleFileMessage — video_note and animation
  // ═══════════════════════════════════════════════════════════════════════════

  describe("handleFileMessage: video_note", () => {
    it("downloads and dispatches video_note as file attachment", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      await adapter.connect("telegram://200", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 20,
        message: {
          message_id: 40,
          chat: { id: 200 },
          from: { id: 20, username: "nina" },
          video_note: { file_id: "vn-file-123", length: 240, duration: 5 },
        },
      });

      // Wait for async file download
      await new Promise((r) => setTimeout(r, 100));

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.type).toBe("chat");
      expect(msg.files).toBeDefined();
      expect(msg.files.length).toBe(1);
      expect(msg.files[0].name).toBe("video_note.mp4");
      expect(msg.files[0].mime).toBe("video/mp4");
      expect(msg.meta.file_type).toBe("video_note");

      await adapter.close();
    });
  });

  describe("handleFileMessage: animation (GIF)", () => {
    it("downloads and dispatches animation as file attachment", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      await adapter.connect("telegram://201", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 21,
        message: {
          message_id: 41,
          chat: { id: 201 },
          from: { id: 21, username: "oscar" },
          animation: { file_id: "anim-file-456", file_name: "funny.gif", mime_type: "video/mp4" },
          caption: "Look at this!",
        },
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.type).toBe("chat");
      expect(msg.content).toBe("Look at this!");
      expect(msg.files[0].name).toBe("funny.gif");
      expect(msg.meta.file_type).toBe("animation");

      await adapter.close();
    });
  });

  describe("handleFileMessage: reply_to and forward metadata on file messages", () => {
    it("includes reply_to and forward_from meta on photo messages", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://202", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 22,
        message: {
          message_id: 42,
          chat: { id: 202 },
          from: { id: 22, username: "pat" },
          photo: [
            { file_id: "small", width: 100, height: 100 },
            { file_id: "large-photo-id", width: 800, height: 600 },
          ],
          reply_to_message: {
            message_id: 38,
            from: { id: 23, username: "quinn" },
            text: "Previous message",
          },
          forward_from: { id: 24, username: "rachel" },
        },
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(received.length).toBe(1);
      const msg = received[0];
      expect(msg.meta.reply_to_id).toBe("38");
      expect(msg.meta.reply_to_user).toBe("quinn");
      expect(msg.meta.forwarded_from).toBe("rachel");

      await adapter.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SENDING: new transport methods
  // ═══════════════════════════════════════════════════════════════════════════

  describe("sendLocation method", () => {
    it("calls Telegram sendLocation API", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://300", () => {}) as any;
      await transport.sendLocation("300", 48.8566, 2.3522);

      const locationCall = fetchCalls.find((u) => u.includes("/sendLocation"));
      expect(locationCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("sendVenue method", () => {
    it("calls Telegram sendVenue API", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://301", () => {}) as any;
      await transport.sendVenue("301", 48.8584, 2.2945, "Eiffel Tower", "Paris, France");

      const venueCall = fetchCalls.find((u) => u.includes("/sendVenue"));
      expect(venueCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("sendContact method", () => {
    it("calls Telegram sendContact API", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://302", () => {}) as any;
      await transport.sendContact("302", "+33123456789", "Jean", "Dupont");

      const contactCall = fetchCalls.find((u) => u.includes("/sendContact"));
      expect(contactCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("sendPoll method", () => {
    it("calls Telegram sendPoll API", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://303", () => {}) as any;
      await transport.sendPoll("303", "Best language?", ["Rust", "Go", "TypeScript"]);

      const pollCall = fetchCalls.find((u) => u.includes("/sendPoll"));
      expect(pollCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("sendAnimation method", () => {
    it("calls Telegram sendAnimation API with form data", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://304", () => {}) as any;
      const fakeGif = Buffer.from("fake-gif-data");
      await transport.sendAnimation("304", fakeGif, "Funny GIF");

      const animCall = fetchCalls.find((u) => u.includes("/sendAnimation"));
      expect(animCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("sendVideoNote method", () => {
    it("calls Telegram sendVideoNote API", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://305", () => {}) as any;
      const fakeVideo = Buffer.from("fake-video-note");
      await transport.sendVideoNote("305", fakeVideo);

      const vnCall = fetchCalls.find((u) => u.includes("/sendVideoNote"));
      expect(vnCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("sendSticker method", () => {
    it("sends sticker by file_id via JSON", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://306", () => {}) as any;
      await transport.sendSticker("306", "sticker-file-id-abc");

      const stickerCall = fetchCalls.find((u) => u.includes("/sendSticker"));
      expect(stickerCall).toBeDefined();

      await adapter.close();
    });

    it("sends sticker by buffer via multipart", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://306", () => {}) as any;
      const fakeSticker = Buffer.from("fake-sticker");
      await transport.sendSticker("306", fakeSticker);

      const stickerCall = fetchCalls.find((u) => u.includes("/sendSticker"));
      expect(stickerCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("sendMediaGroup method", () => {
    it("calls Telegram sendMediaGroup API", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://307", () => {}) as any;
      await transport.sendMediaGroup("307", [
        { type: "photo", data: Buffer.from("img1"), caption: "Group caption" },
        { type: "photo", data: Buffer.from("img2") },
      ]);

      const mgCall = fetchCalls.find((u) => u.includes("/sendMediaGroup"));
      expect(mgCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("deleteMessage method", () => {
    it("calls Telegram deleteMessage API", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://308", () => {}) as any;
      await transport.deleteMessage("308", 99);

      const delCall = fetchCalls.find((u) => u.includes("/deleteMessage"));
      expect(delCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("answerCallbackQuery method", () => {
    it("calls Telegram answerCallbackQuery API", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://309", () => {}) as any;
      await transport.answerCallbackQuery("cb-id-789", "Done!", true);

      const acqCall = fetchCalls.find((u) => u.includes("/answerCallbackQuery"));
      expect(acqCall).toBeDefined();

      await adapter.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SENDING: send() routing via meta
  // ═══════════════════════════════════════════════════════════════════════════

  describe("send() routes location via meta", () => {
    it("sends location when meta has latitude and longitude", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://400", () => {});
      await transport.send({
        type: "chat",
        chat_id: "400",
        content: "",
        meta: { latitude: "51.5074", longitude: "-0.1278" },
      } as any);

      const locCall = fetchCalls.find((u) => u.includes("/sendLocation"));
      expect(locCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("send() routes venue via meta", () => {
    it("sends venue when meta has lat/lng plus title/address", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://401", () => {});
      await transport.send({
        type: "chat",
        chat_id: "401",
        content: "",
        meta: {
          latitude: "51.5014",
          longitude: "-0.1419",
          venue_title: "Buckingham Palace",
          venue_address: "London, UK",
        },
      } as any);

      const venueCall = fetchCalls.find((u) => u.includes("/sendVenue"));
      expect(venueCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("send() routes contact via meta", () => {
    it("sends contact when meta has phone_number and contact_first_name", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://402", () => {});
      await transport.send({
        type: "chat",
        chat_id: "402",
        content: "",
        meta: {
          phone_number: "+442071234567",
          contact_first_name: "James",
          contact_last_name: "Bond",
        },
      } as any);

      const contactCall = fetchCalls.find((u) => u.includes("/sendContact"));
      expect(contactCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("send() routes poll via meta", () => {
    it("sends poll when meta has poll_question and poll_options", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://403", () => {});
      await transport.send({
        type: "chat",
        chat_id: "403",
        content: "",
        meta: {
          poll_question: "Tea or coffee?",
          poll_options: JSON.stringify(["Tea", "Coffee"]),
        },
      } as any);

      const pollCall = fetchCalls.find((u) => u.includes("/sendPoll"));
      expect(pollCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("send() routes animation (GIF) via file mime", () => {
    it("uses sendAnimation for image/gif files", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://404", () => {});
      await transport.send({
        type: "chat",
        chat_id: "404",
        content: "Here is a GIF",
        files: [{ name: "cat.gif", mime: "image/gif", data: Buffer.from("gif-data").toString("base64") }],
      } as any);

      const animCall = fetchCalls.find((u) => u.includes("/sendAnimation"));
      expect(animCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("send() routes edit via meta", () => {
    it("edits a message when meta.edit_message_id is set", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://405", () => {});
      await transport.send({
        type: "chat",
        chat_id: "405",
        content: "Updated content",
        meta: { edit_message_id: "99" },
      } as any);

      const editCall = fetchCalls.find((u) => u.includes("/editMessageText"));
      expect(editCall).toBeDefined();
      // Should NOT call sendMessage
      const sendCall = fetchCalls.find((u) => u.includes("/sendMessage"));
      expect(sendCall).toBeUndefined();

      await adapter.close();
    });
  });

  describe("send() routes delete via meta", () => {
    it("deletes a message when meta.delete_message_id is set", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://406", () => {});
      await transport.send({
        type: "chat",
        chat_id: "406",
        content: "",
        meta: { delete_message_id: "88" },
      } as any);

      const delCall = fetchCalls.find((u) => u.includes("/deleteMessage"));
      expect(delCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("send() routes callback_query_id answer via meta", () => {
    it("answers callback query when meta.callback_query_id is set", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://407", () => {});
      await transport.send({
        type: "chat",
        chat_id: "407",
        content: "Action completed",
        meta: { callback_query_id: "cq-999" },
      } as any);

      const acqCall = fetchCalls.find((u) => u.includes("/answerCallbackQuery"));
      expect(acqCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("send() supports media group for multiple photos", () => {
    it("uses sendMediaGroup for multiple image files", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://408", () => {});
      await transport.send({
        type: "chat",
        chat_id: "408",
        content: "Album",
        files: [
          { name: "img1.jpg", mime: "image/jpeg", data: Buffer.from("img1").toString("base64") },
          { name: "img2.jpg", mime: "image/jpeg", data: Buffer.from("img2").toString("base64") },
          { name: "img3.jpg", mime: "image/jpeg", data: Buffer.from("img3").toString("base64") },
        ],
      } as any);

      const mgCall = fetchCalls.find((u) => u.includes("/sendMediaGroup"));
      expect(mgCall).toBeDefined();

      await adapter.close();
    });
  });

  describe("send() supports reply_to threading", () => {
    it("includes reply_parameters when reply_to is set", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      const fetchBodies: any[] = [];

      fetchSpy.mockImplementation(async (url: any, init?: any) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        fetchCalls.push(urlStr);
        if (init?.body && typeof init.body === "string") {
          fetchBodies.push(JSON.parse(init.body));
        }
        return makeFetchOk();
      });

      const transport = await adapter.connect("telegram://409", () => {});
      await transport.send({
        type: "chat",
        chat_id: "409",
        content: "Threaded reply",
        reply_to: "42",
      } as any);

      const sendBody = fetchBodies.find((b) => b.reply_parameters?.message_id === 42);
      expect(sendBody).toBeDefined();
      expect(sendBody.text).toContain("Threaded reply");

      await adapter.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REGRESSION: existing types still work
  // ═══════════════════════════════════════════════════════════════════════════

  describe("regression: text messages still dispatch", () => {
    it("text messages dispatch normally", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://500", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 50,
        message: {
          message_id: 60,
          chat: { id: 500 },
          from: { id: 50, username: "zack" },
          text: "Hello world",
        },
      });

      expect(received.length).toBe(1);
      expect(received[0].type).toBe("chat");
      expect(received[0].content).toBe("Hello world");

      await adapter.close();
    });
  });

  describe("regression: photo messages still dispatch", () => {
    it("photo messages download and dispatch", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      await adapter.connect("telegram://501", (msg) => received.push(msg));

      (adapter as any).dispatchUpdate({
        update_id: 51,
        message: {
          message_id: 61,
          chat: { id: 501 },
          from: { id: 51, username: "yvonne" },
          photo: [
            { file_id: "small-photo", width: 100, height: 100 },
            { file_id: "large-photo", width: 800, height: 600 },
          ],
          caption: "Nice view",
        },
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(received.length).toBe(1);
      expect(received[0].content).toBe("Nice view");
      expect(received[0].files[0].name).toBe("photo.jpg");
      expect(received[0].files[0].mime).toBe("image/jpeg");

      await adapter.close();
    });
  });

  describe("regression: voice messages still dispatch with STT fallback", () => {
    it("voice without API key shows fallback", async () => {
      const adapter = createTestAdapter();
      const received: any[] = [];
      mockTelegramFetch(fetchSpy, []);

      const transport = await adapter.connect("telegram://502", (msg) => received.push(msg));

      (transport as any).handleIncoming("[Voice message - transcription failed]", {
        message_id: 70,
        from: { id: 60, username: "wendy" },
        voice: true,
        duration: 8,
        file_id: "voice-abc",
      });

      expect(received.length).toBe(1);
      expect(received[0].meta.voice).toBe("true");
      expect(received[0].meta.duration).toBe("8");

      await adapter.close();
    });
  });

  describe("regression: send() still works for plain text", () => {
    it("sendMessage for normal chat without special meta", async () => {
      const adapter = createTestAdapter();
      const fetchCalls: string[] = [];
      mockTelegramFetch(fetchSpy, fetchCalls);

      const transport = await adapter.connect("telegram://503", () => {});
      await transport.send({
        type: "chat",
        chat_id: "503",
        content: "Just a regular message",
      } as any);

      const textCall = fetchCalls.find((u) => u.includes("/sendMessage"));
      expect(textCall).toBeDefined();

      await adapter.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // pickSendMethod routing
  // ═══════════════════════════════════════════════════════════════════════════

  describe("pickSendMethod file type routing", () => {
    it("routes image/gif to sendAnimation", async () => {
      const adapter = createTestAdapter();
      mockTelegramFetch(fetchSpy, []);
      const transport = await adapter.connect("telegram://600", () => {}) as any;
      expect(transport.pickSendMethod("image/gif", "cat.gif")).toBe("sendAnimation");
      await adapter.close();
    });

    it("routes video/gif to sendAnimation", async () => {
      const adapter = createTestAdapter();
      mockTelegramFetch(fetchSpy, []);
      const transport = await adapter.connect("telegram://601", () => {}) as any;
      expect(transport.pickSendMethod("video/gif", "dance.gif")).toBe("sendAnimation");
      await adapter.close();
    });

    it("routes image/jpeg to sendPhoto", async () => {
      const adapter = createTestAdapter();
      mockTelegramFetch(fetchSpy, []);
      const transport = await adapter.connect("telegram://602", () => {}) as any;
      expect(transport.pickSendMethod("image/jpeg", "photo.jpg")).toBe("sendPhoto");
      await adapter.close();
    });

    it("routes audio/ogg to sendAudio", async () => {
      const adapter = createTestAdapter();
      mockTelegramFetch(fetchSpy, []);
      const transport = await adapter.connect("telegram://603", () => {}) as any;
      expect(transport.pickSendMethod("audio/ogg", "song.ogg")).toBe("sendAudio");
      await adapter.close();
    });

    it("routes video/mp4 to sendVideo", async () => {
      const adapter = createTestAdapter();
      mockTelegramFetch(fetchSpy, []);
      const transport = await adapter.connect("telegram://604", () => {}) as any;
      expect(transport.pickSendMethod("video/mp4", "clip.mp4")).toBe("sendVideo");
      await adapter.close();
    });

    it("routes video/mp4 with video_note name to sendVideoNote", async () => {
      const adapter = createTestAdapter();
      mockTelegramFetch(fetchSpy, []);
      const transport = await adapter.connect("telegram://605", () => {}) as any;
      expect(transport.pickSendMethod("video/mp4", "video_note.mp4")).toBe("sendVideoNote");
      await adapter.close();
    });

    it("routes unknown mime to sendDocument", async () => {
      const adapter = createTestAdapter();
      mockTelegramFetch(fetchSpy, []);
      const transport = await adapter.connect("telegram://606", () => {}) as any;
      expect(transport.pickSendMethod("application/pdf", "report.pdf")).toBe("sendDocument");
      await adapter.close();
    });

    it("routes undefined mime to sendDocument", async () => {
      const adapter = createTestAdapter();
      mockTelegramFetch(fetchSpy, []);
      const transport = await adapter.connect("telegram://607", () => {}) as any;
      expect(transport.pickSendMethod(undefined, "mystery")).toBe("sendDocument");
      await adapter.close();
    });
  });
});
