/**
 * TruckSchedulePanel
 *
 * Elevated schedule presentation for food trucks. Answers the core question:
 * "Where is this truck and when can I find it?"
 *
 * Priority display:
 *   1. Current scheduled stop
 *   2. Today's stop
 *   3. Next stop
 *   4. Upcoming schedule list
 *   5. Closed stops (collapsed)
 *
 * Thin state: renders "No schedule posted" and offers a claim CTA only when
 * the truck is still unclaimed.
 */
import type {
  PublicRestaurantProfile,
  PublicTruckScheduleStop,
} from "@shared/publicProfiles";
import {
  getTruckScheduleRows,
  getTruckScheduleEmptyStateLabel,
  getTruckScheduleStatusBadgeLabel,
} from "./truckScheduleTruth";
import { shouldShowPublicClaimPrompt } from "./profileClaimPromptPolicy";
import { MapPin, Clock3, ExternalLink, CalendarDays } from "lucide-react";

type StopRowProps = {
  label: string;
  stop: PublicTruckScheduleStop;
  isCurrent?: boolean;
};

function StopRow({ label, stop, isCurrent = false }: StopRowProps) {
  const locationName = stop.locationName || stop.addressPublicLabel || null;
  const timeLabel = stop.timeWindowLabel || null;
  const directionsHref =
    stop.directionsUrl ||
    (typeof stop.latitude === "number" && Number.isFinite(stop.latitude) &&
     typeof stop.longitude === "number" && Number.isFinite(stop.longitude) &&
     Math.abs(stop.latitude) <= 90 && Math.abs(stop.longitude) <= 180 &&
     (stop.latitude !== 0 || stop.longitude !== 0)
      ? `https://maps.google.com/?q=${stop.latitude},${stop.longitude}`
      : null);

  return (
    <div
      className={`rounded-2xl border p-4 space-y-2 ${
        isCurrent
          ? "border-orange-200 bg-orange-50"
          : "border-[color:var(--profile-border)] bg-white"
      }`}
    >
      <p
        className={`text-[10px] font-bold uppercase tracking-[0.18em] ${
          isCurrent ? "text-orange-800" : "text-[color:var(--profile-muted)]"
        }`}
      >
        {label}
      </p>

      {locationName ? (
        <p
          className="text-base font-bold leading-snug text-[color:var(--profile-ink)]"
        >
          {locationName}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[color:var(--profile-muted)]">
        {stop.date ? (
          <span className="flex items-center gap-1">
            <CalendarDays className="h-3.5 w-3.5 flex-none text-[color:var(--profile-accent)]" />
            {stop.date}
          </span>
        ) : null}
        {timeLabel ? (
          <span className="flex items-center gap-1">
            <Clock3 className="h-3.5 w-3.5 flex-none text-[color:var(--profile-accent)]" />
            {timeLabel}
          </span>
        ) : null}
        {stop.addressPublicLabel && stop.addressPublicLabel !== locationName ? (
          <span className="flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5 flex-none text-[color:var(--profile-accent)]" />
            {stop.addressPublicLabel}
          </span>
        ) : null}
      </div>

      {stop.notice ? (
        <p className="text-xs italic text-[color:var(--profile-muted)]">{stop.notice}</p>
      ) : null}

      {directionsHref ? (
        <a
          href={directionsHref}
          target="_blank"
          rel="noopener noreferrer"
          data-analytics-action="directions_click"
          data-analytics-target-type="truck_schedule"
          className="inline-flex items-center gap-1 text-xs font-semibold text-[#b93619] hover:text-[#8f2a14]"
        >
          Get directions <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  );
}

export function TruckSchedulePanel({
  profile,
}: {
  profile: PublicRestaurantProfile;
}) {
  if (profile.profileType !== "truck") return null;

  const schedule = profile.truckSchedule;
  const {
    currentStop,
    todayStop,
    nextStop,
    upcomingStops,
    closedStops,
    hasActionableSchedule,
  } = getTruckScheduleRows(schedule);

  const statusBadge = getTruckScheduleStatusBadgeLabel(schedule);
  const hasClosedSchedule = closedStops.length > 0;

  return (
    <section id="truck-schedule" aria-label="Truck schedule" className="scroll-mt-24 space-y-3">
      <div className="flex items-center justify-between">
        <p className="profile-section-label">
          Schedule
        </p>
        {statusBadge ? (
          <span className="rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 text-[10px] font-bold text-orange-800">
            {statusBadge}
          </span>
        ) : null}
      </div>
      {profile.timeZone ? (
        <p className="text-xs text-[color:var(--profile-muted)]">
          Schedule times shown in {profile.timeZone}
        </p>
      ) : null}

      {hasActionableSchedule ? (
        <div className="space-y-2">
          {currentStop ? (
            <StopRow label="Scheduled here now" stop={currentStop} isCurrent />
          ) : null}
          {!currentStop && todayStop ? (
            <StopRow label="Today's stop" stop={todayStop} />
          ) : null}
          {!currentStop && !todayStop && nextStop ? (
            <StopRow label="Next stop" stop={nextStop} />
          ) : null}

          {upcomingStops.length > 0 ? (
            <div className="space-y-2">
              <p className="profile-section-label pt-1 text-[10px]">
                Upcoming
              </p>
              {upcomingStops.map((stop, i) => (
                <div
                  key={`${stop.stopId || stop.date || "stop"}:${i}`}
                  className="flex items-start gap-3 rounded-xl border border-[color:var(--profile-border)] bg-white px-3 py-2.5"
                >
                  <CalendarDays className="mt-0.5 h-4 w-4 flex-none text-[color:var(--profile-accent)]" />
                  <div className="min-w-0">
                    {nextStop && stop.stopId === nextStop.stopId ? (
                      <p className="profile-section-label text-[10px]">Next stop</p>
                    ) : null}
                    <p className="break-words text-sm font-medium text-[color:var(--profile-ink)]">
                      {stop.locationName ||
                        stop.addressPublicLabel ||
                        "Scheduled stop"}
                    </p>
                    <p className="text-xs text-[color:var(--profile-muted)]">
                      {[stop.date, stop.timeWindowLabel]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {stop.directionsUrl ? (
                      <a href={stop.directionsUrl} target="_blank" rel="noopener noreferrer"
                        data-analytics-action="directions_click" data-analytics-target-type="truck_schedule"
                        className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-[#b93619] hover:text-[#8f2a14]">
                        Get directions <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {schedule?.notice ? (
            <p className="rounded-xl border border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)] px-3 py-2.5 text-xs text-[color:var(--profile-muted)]">
              {schedule.notice}
            </p>
          ) : null}
        </div>
      ) : hasClosedSchedule ? (
        <div className="space-y-2 rounded-2xl border border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)] p-4">
          <p className="profile-section-label text-[10px]">Closed days</p>
          {closedStops.map((stop, index) => (
            <StopRow
              key={`${stop.stopId || stop.date || "closed"}:${index}`}
              label="Closed"
              stop={stop}
            />
          ))}
        </div>
      ) : (
        /* Thin state — no schedule posted */
        <div className="space-y-2 rounded-2xl border border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)] px-4 py-5 text-center">
          <p className="text-sm text-[color:var(--profile-muted)]">
            {getTruckScheduleEmptyStateLabel()}
          </p>
          {shouldShowPublicClaimPrompt(profile) ? (
            <a
              href="/claim-business"
              className="inline-block text-xs font-semibold text-[#b93619] hover:text-[#8f2a14]"
            >
              Own this truck? Add your schedule →
            </a>
          ) : null}
        </div>
      )}
    </section>
  );
}
