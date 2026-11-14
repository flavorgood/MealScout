import assert from "node:assert/strict";
import test from "node:test";
import { getEventCalendarDateKey, formatEventCalendarDate } from "../client/src/lib/public-event-display";

test("calendar keys retain the venue day for ISO markers and date-only payloads", () => {
  for (const value of ["2026-11-07", "2026-11-07T00:00:00.000Z", "2026-11-07T12:00:00.000Z"]) {
    assert.equal(getEventCalendarDateKey(value), "2026-11-07");
  }
  assert.equal(getEventCalendarDateKey("2024-02-29"), "2024-02-29");
  assert.ok(formatEventCalendarDate("2026-11-07"));
});

test("impossible or absent calendar dates are never normalized to another day", () => {
  for (const value of [undefined, null, "", "not-a-date", "2026-02-29", "2026-02-30", "2026-13-01", "2026-00-01", "2026-11-00", "11/07/2026"]) {
    assert.equal(getEventCalendarDateKey(value), null);
    assert.equal(formatEventCalendarDate(value), null);
  }
});
