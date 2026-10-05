// Match the existing 10mb JSON request limit; this is a local paste guard only.
export const OWNER_AI_PACKET_INPUT_MAX_BYTES = 10 * 1024 * 1024;

export class OwnerAiPacketInputError extends Error {
  constructor(
    public readonly code: "INPUT_TOO_LARGE" | "INVALID_JSON" | "INVALID_OBJECT",
    message: string,
  ) {
    super(message);
    this.name = "OwnerAiPacketInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Decode the existing MealScout packet/request formats, optionally surrounded
 * by one JSON code fence. No content is executed, rendered, fetched or approved.
 * Leave semantic validation and unknown-field rejection to the native schema.
 */
export function parseOwnerAiDraftText(text: string): Record<string, unknown> {
  if (
    text.length > OWNER_AI_PACKET_INPUT_MAX_BYTES ||
    new TextEncoder().encode(text).byteLength > OWNER_AI_PACKET_INPUT_MAX_BYTES
  ) {
    throw new OwnerAiPacketInputError(
      "INPUT_TOO_LARGE",
      "This packet is too large for MealScout. Split it into smaller drafts.",
    );
  }

  let json = text.trim();
  if (json.startsWith(String.fromCharCode(96).repeat(3))) {
    const fenced = /^\x60{3}(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n\x60{3}[ \t]*$/i.exec(json);
    if (!fenced) {
      throw new OwnerAiPacketInputError(
        "INVALID_JSON",
        "Paste only the JSON packet or one JSON code block from your AI.",
      );
    }
    json = fenced[1];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new OwnerAiPacketInputError(
      "INVALID_JSON",
      "Paste valid MealScout JSON or one JSON code block from your AI.",
    );
  }
  if (!isRecord(parsed)) {
    throw new OwnerAiPacketInputError(
      "INVALID_OBJECT",
      "Use a MealScout JSON object containing a packet or proposed changes.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "packet")) {
    if (!isRecord(parsed.packet)) {
      throw new OwnerAiPacketInputError(
        "INVALID_OBJECT",
        "The request's packet must be a MealScout JSON object.",
      );
    }
    return parsed;
  }
  return { packet: parsed };
}
