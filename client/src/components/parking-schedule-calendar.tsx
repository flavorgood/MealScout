import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isBefore,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/relative-time";

export type ParkingScheduleItem = {
  id: string;
  // API service days are date keys or their UTC-midnight serialization.
  // Date objects and other ISO timestamps retain local instant semantics.
  date: string | Date;
  startTime?: string | null;
  endTime?: string | null;
  cleanupEndTime?: string | null;
  title: string;
  subtitle?: string | null;
  type: "booking" | "manual" | "accepted_interest";
  slotLabel?: string | null;
  isPublic?: boolean | null;
  lastConfirmedAt?: string | Date | null;
  manualId?: string;
  bookingId?: string;
  hostId?: string;
  locationName?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  reportKey?: string;
};

type ParkingScheduleCalendarProps = {
  items: ParkingScheduleItem[];
  initialDate?: string;
  onDateChange?: (date: string) => void;
  bookingsState?: "loading" | "unavailable" | "ready";
  bookingActionsDisabled?: boolean;
  title?: string;
  subtitle?: string;
  allowManualEdits?: boolean;
  onDeleteManual?: (manualId: string) => void;
  onCancelBooking?: (bookingId: string, item: ParkingScheduleItem) => void;
  cancelingBookingId?: string | null;
  reportLookup?: Record<string, boolean>;
  onAddReport?: (item: ParkingScheduleItem) => void;
  className?: string;
};

const typeBadgeClass: Record<ParkingScheduleItem["type"], string> = {
  booking: "pp-calendar-badge pp-calendar-badge--booking",
  manual: "pp-calendar-badge pp-calendar-badge--manual",
  accepted_interest: "pp-calendar-badge pp-calendar-badge--accepted",
};

const typeDotClass: Record<ParkingScheduleItem["type"], string> = {
  booking: "pp-calendar-dot pp-calendar-dot--booking",
  manual: "pp-calendar-dot pp-calendar-dot--manual",
  accepted_interest: "pp-calendar-dot pp-calendar-dot--accepted",
};

const toDate = (value: string | Date) => {
  if (value instanceof Date) return value;
  const parsed = parseISO(value);
  if (!Number.isFinite(parsed.getTime())) return parsed;
  // Manual-schedule and booked-stop dates are calendar days; their clock
  // fields are separate. Only unwrap the canonical API day marker here.
  const serviceDay = value.match(/^(\d{4}-\d{2}-\d{2})T00:00:00\.000Z$/)?.[1];
  return serviceDay ? parseISO(serviceDay) : parsed;
};

const toDateKey = (value: string | Date) => format(toDate(value), "yyyy-MM-dd");

// Treat date-only links as local calendar dates; invalid input falls back safely.
export function resolveScheduleInitialDate(value?: string, now = new Date()): Date {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = parseISO(value);
    if (!Number.isNaN(date.getTime()) && format(date, "yyyy-MM-dd") === value) return date;
  }
  return now;
}

export function ParkingScheduleCalendar({
  items,
  initialDate,
  onDateChange,
  bookingsState = "ready",
  bookingActionsDisabled = false,
  title = "Parking Schedule",
  subtitle = "Auto-updated by Parking Pass bookings. Add manual stops anytime.",
  allowManualEdits = false,
  onDeleteManual,
  onCancelBooking,
  cancelingBookingId,
  reportLookup,
  onAddReport,
  className,
}: ParkingScheduleCalendarProps) {
  const [initialAnchor] = useState(() => resolveScheduleInitialDate(initialDate));
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(initialAnchor));
  const [activeDate, setActiveDate] = useState(() => initialAnchor);
  const selectDate = (date: Date, showMonth = false) => {
    setActiveDate(date);
    if (showMonth) setMonthAnchor(startOfMonth(date));
    onDateChange?.(toDateKey(date));
  };

  const itemsByDate = useMemo(() => {
    const map = new Map<string, ParkingScheduleItem[]>();
    items.forEach((item) => {
      const key = toDateKey(item.date);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    });
    for (const list of map.values()) {
      list.sort((a, b) => {
        const timeA = a.startTime || "";
        const timeB = b.startTime || "";
        return timeA.localeCompare(timeB);
      });
    }
    return map;
  }, [items]);

  const nextDayKey = [...itemsByDate.keys()].filter(key => key > toDateKey(activeDate)).sort()[0];

  const calendarDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(monthAnchor), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(monthAnchor), { weekStartsOn: 0 });
    const days: Date[] = [];
    for (let day = start; day <= end; day = addDays(day, 1)) {
      days.push(day);
    }
    return days;
  }, [monthAnchor]);

  const activeKey = toDateKey(activeDate);
  const activeItems = itemsByDate.get(activeKey) ?? [];
  const today = useMemo(() => {
    const value = new Date();
    value.setHours(0, 0, 0, 0);
    return value;
  }, []);

  return (
      <div className={className}>
        <div className="parking-schedule-calendar rounded-2xl pp-glass overflow-hidden">
          <div className="pp-calendar-header flex flex-col gap-2 border-b border-[color:var(--border-subtle)] px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{title}</p>
                <p className="text-xs text-muted-foreground">{subtitle}</p>
              </div>
              <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11"
                onClick={() => setMonthAnchor((current) => addMonths(current, -1))}
                aria-label="Previous month"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="min-w-[140px] text-center text-sm font-semibold text-foreground">
                {format(monthAnchor, "MMMM yyyy")}
              </div>
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11"
                onClick={() => setMonthAnchor((current) => addMonths(current, 1))}
                aria-label="Next month"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="min-h-11" aria-pressed={isToday(activeDate)} onClick={() => selectDate(new Date(), true)}>Today</Button>
            <Button type="button" variant="outline" className="min-h-11" disabled={!nextDayKey} onClick={() => { if (nextDayKey) selectDate(parseISO(nextDayKey), true); }}>Next scheduled day</Button>
          </div>
          <div className="grid grid-cols-7 gap-2 text-[11px] text-muted-foreground">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label) => (
              <span key={label} className="text-center uppercase tracking-wide">
                {label}
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-7 gap-2 p-4">
          {calendarDays.map((day) => {
            const key = toDateKey(day);
            const dayItems = itemsByDate.get(key) ?? [];
            const isCurrentMonth = isSameMonth(day, monthAnchor);
            const isActive = isSameDay(day, activeDate);
            return (
              <button
                key={key}
                type="button"
                aria-label={format(day, "EEEE, MMMM d, yyyy")}
                aria-pressed={isActive}
                onClick={() => selectDate(day)}
                className={`pp-calendar-day h-14 sm:h-auto sm:min-h-[84px] rounded-lg border px-1 py-2 text-left transition sm:px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                  isActive ? "pp-calendar-day--active" : "pp-calendar-day--idle"
                } ${isCurrentMonth ? "pp-calendar-day--in-month" : "pp-calendar-day--out-month"}`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs font-semibold ${
                      isToday(day) ? "text-orange-600" : "text-inherit"
                    }`}
                  >
                    {format(day, "d")}
                  </span>
                  {dayItems.length > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {dayItems.length}
                    </span>
                  )}
                </div>

                {/* Mobile: keep cells compact (dots only) */}
                <div className="mt-2 flex flex-wrap gap-1 sm:hidden">
                  {dayItems.slice(0, 4).map((item) => (
                    <span
                      key={item.id}
                      className={`h-1.5 w-1.5 rounded-full ${typeDotClass[item.type]}`}
                      aria-hidden="true"
                    />
                  ))}
                </div>

                {/* Desktop: show labels */}
                <div className="mt-2 hidden sm:flex sm:flex-col sm:gap-1">
                  {dayItems.slice(0, 2).map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-1 text-[10px] text-muted-foreground"
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${typeDotClass[item.type]}`}
                      />
                      <span className="truncate">{item.title}</span>
                    </div>
                  ))}
                  {dayItems.length > 2 && (
                    <span className="text-[10px] text-muted-foreground">
                      +{dayItems.length - 2} more
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <Card className="mt-4 rounded-2xl pp-glass">
        <CardContent className="p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {format(activeDate, "EEEE, MMM d")}
              </p>
              <p className="text-xs text-muted-foreground">
                {activeItems.length
                  ? `${activeItems.length} stop${
                      activeItems.length === 1 ? "" : "s"
                    } scheduled`
                  : bookingsState === "loading" ? "Checking booked stops…"
                    : bookingsState === "unavailable" ? "Booked stops could not be verified"
                    : "No stops scheduled"}
              </p>
            </div>
          </div>

          {activeItems.length > 0 ? (
            <div className="mt-4 space-y-3">
              {activeItems.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl pp-glass-muted p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${typeBadgeClass[item.type]}`}
                        >
                          {item.type === "booking"
                            ? "Parking Pass"
                            : item.type === "manual"
                              ? "Manual"
                              : "Accepted"}
                        </Badge>
                        {item.isPublic === false && (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-[var(--border-subtle)] text-slate-500"
                          >
                            Private
                          </Badge>
                        )}
                      </div>
                      <p className="mt-2 text-sm font-semibold text-foreground">
                        {item.title}
                      </p>
                      {item.subtitle && (
                        <p className="text-xs text-muted-foreground">{item.subtitle}</p>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.startTime && item.endTime
                          ? `${item.startTime} - ${item.endTime}`
                          : "Time not set"}
                        {item.cleanupEndTime
                          ? ` | Cleanup until ${item.cleanupEndTime}`
                          : ""}
                        {item.slotLabel ? ` | ${item.slotLabel}` : ""}
                      </p>
                      {item.lastConfirmedAt ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Last confirmed:{" "}
                          {formatRelativeTime(item.lastConfirmedAt) ?? "unknown"}
                        </p>
                      ) : null}
                    </div>
                    {allowManualEdits &&
                      item.type === "manual" &&
                      item.manualId &&
                      onDeleteManual && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onDeleteManual(item.manualId!)}
                        >
                          Remove
                        </Button>
                      )}
                    {onCancelBooking &&
                      item.type === "booking" &&
                      item.bookingId &&
                      !isBefore(toDate(item.date), today) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onCancelBooking(item.bookingId!, item)}
                          disabled={bookingActionsDisabled || cancelingBookingId === item.bookingId}
                        >
                          {cancelingBookingId === item.bookingId
                            ? "Cancelling..."
                            : "Cancel booking"}
                        </Button>
                      )}
                    {onAddReport && item.reportKey && (
                      <div className="flex items-center gap-2">
                        {reportLookup?.[item.reportKey] && (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-emerald-200 text-emerald-700"
                          >
                            Report saved
                          </Badge>
                        )}
                        {(isSameDay(toDate(item.date), today) ||
                          isBefore(toDate(item.date), today)) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onAddReport(item)}
                          >
                            {reportLookup?.[item.reportKey]
                              ? "Edit report"
                              : "Add day report"}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-[color:var(--border-subtle)] pp-glass-muted p-6 text-center text-xs text-muted-foreground">
              {bookingsState === "loading" ? "Your booked stops are still loading. Manual stops remain available."
                : bookingsState === "unavailable" ? "Retry the booked-stops check above. A failed lookup does not mean there are no reservations."
                : "Choose another day to see scheduled stops."}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

