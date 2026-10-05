import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OWNER_AI_PACKET_INPUT_MAX_BYTES,
  OwnerAiPacketInputError,
  parseOwnerAiDraftText,
} from "../shared/ownerAiPacketInput";
import { ownerAiDraftRequestSchema } from "../shared/ownerAiActions";

const fence = String.fromCharCode(96).repeat(3);
const packet = {
  schemaVersion: "1.0",
  intent: "Review this food truck's profile description",
  source: { tool: "ChatGPT" },
  profile: { description: "Fresh food, confirmed with the owner 🍊" },
};
const versions = {
  restaurant: "a".repeat(64),
  menus: "b".repeat(64),
  schedules: "c".repeat(64),
  deals: "d".repeat(64),
};
const envelope = { packet, expectedVersions: versions };
const fenced = (body: string, language = "json", newline = "\n") =>
  fence + language + newline + body + newline + fence;
const fails = (input: string, code: OwnerAiPacketInputError["code"]) => {
  assert.throws(() => parseOwnerAiDraftText(input), (error: unknown) =>
    error instanceof OwnerAiPacketInputError && error.code === code,
  );
};

test("raw packet stays the existing request and passes the native schema", () => {
  const result = parseOwnerAiDraftText(JSON.stringify(packet));
  assert.deepEqual(result, { packet });
  assert.equal(ownerAiDraftRequestSchema.safeParse(result).success, true);
});

test("request envelope preserves every expected native version", () => {
  const result = parseOwnerAiDraftText(JSON.stringify(envelope));
  assert.deepEqual(result, envelope);
  assert.equal(ownerAiDraftRequestSchema.safeParse(result).success, true);
});

for (const [language, newline] of [["json", "\n"], ["JSON", "\r\n"], ["", "\n"]]) {
  test("one " + (language || "unlabelled") + " code block preserves the request", () => {
    assert.deepEqual(parseOwnerAiDraftText(fenced(JSON.stringify(envelope), language, newline)), envelope);
  });
}

test("outer whitespace and BOM are formatting only", () => {
  assert.deepEqual(parseOwnerAiDraftText("\uFEFF \n" + fenced(JSON.stringify(packet)) + "\n "), { packet });
});

test("menu/schedule/source/approval data is not rewritten", () => {
  const input = {
    packet: {
      ...packet,
      menus: [{ id: "existing-menu", categories: [{ id: "existing-category", items: [{ id: "existing-item", name: "Lunch", price: null }] }] }],
      schedules: [{ id: "existing-stop", kind: "parking_booking", bookingId: "existing-booking" }],
      sourceFacts: { version: 2, fields: [{ path: "profile.description", sourceUrl: "https://official.example", capturedAt: "2026-10-05T10:00:00Z" }] },
    },
    expectedVersions: versions,
  };
  assert.deepEqual(parseOwnerAiDraftText(fenced(JSON.stringify(input))), input);
});

for (const input of ["null", "[]", "\"text\"", "true", "42", "{\"packet\":null}", "{\"packet\":[]}"]) {
  test("non-object packet is rejected before a request: " + input, () => fails(input, "INVALID_OBJECT"));
}

for (const input of [
  "",
  "{\"intent\":",
  "<html><script>run()</script></html>",
  "Here is your packet:\n" + fenced(JSON.stringify(packet)),
  fenced(JSON.stringify(packet)) + "\nPublish this now",
  fenced(JSON.stringify(packet), "javascript"),
  fenced(JSON.stringify(packet)) + "\n" + fenced(JSON.stringify(packet)),
]) {
  test("unsupported or ambiguous text is rejected without echoing it", () => {
    fails(input, "INVALID_JSON");
    try { parseOwnerAiDraftText(input); }
    catch (error) {
      assert.ok(error instanceof OwnerAiPacketInputError);
      assert.ok(!error.message.includes("<script>"));
      assert.ok(!error.message.includes("Publish this now"));
    }
  });
}

test("JSON content is data and unknown fields remain for native rejection", () => {
  const input = JSON.parse('{"packet":{"schemaVersion":"1.0","intent":"review","profile":{"description":"<script>not executed</script>"}},"__proto__":{"approved":true},"approved":true}');
  const result = parseOwnerAiDraftText(JSON.stringify(input));
  assert.deepEqual(result, input);
  assert.equal(({} as Record<string, unknown>).approved, undefined);
  assert.equal(ownerAiDraftRequestSchema.safeParse(result).success, false);
});

test("unsupported native HTML/CSS fields are not silently converted or dropped", () => {
  const input = { ...packet, html: "<h1>Generated</h1>", css: "body { color: red }" };
  const result = parseOwnerAiDraftText(fenced(JSON.stringify(input)));
  assert.deepEqual(result, { packet: input });
  assert.equal(ownerAiDraftRequestSchema.safeParse(result).success, false);
});

test("ASCII input is bounded before decoding and reports no content", () => {
  fails("x".repeat(OWNER_AI_PACKET_INPUT_MAX_BYTES + 1), "INPUT_TOO_LARGE");
});

test("the cap counts UTF-8 bytes rather than JavaScript characters", () => {
  const text = "🍊".repeat(Math.floor(OWNER_AI_PACKET_INPUT_MAX_BYTES / 4) + 1);
  assert.ok(text.length < OWNER_AI_PACKET_INPUT_MAX_BYTES);
  fails(text, "INPUT_TOO_LARGE");
});
