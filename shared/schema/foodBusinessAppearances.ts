import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { restaurants, users } from "./legacy";

// Dated appearances for fixed and service food businesses, independent of truck movement or host booking/payment authority.
export const foodBusinessAppearances = pgTable("food_business_appearances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
  ownerId: varchar("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  profileType: varchar("profile_type").notNull(),
  date: timestamp("date").notNull(), startTime: varchar("start_time"), endTime: varchar("end_time"),
  locationName: varchar("location_name"), address: varchar("address"), city: varchar("city"), state: varchar("state"), notes: varchar("notes"),
  isPublic: boolean("is_public").notNull().default(false), status: varchar("status").notNull(), scheduleType: varchar("schedule_type"),
  timezone: varchar("timezone"), sourceType: varchar("source_type"), sourceArtifact: varchar("source_artifact"), sourceEvidence: jsonb("source_evidence"),
  expiresAt: timestamp("expires_at"), lastConfirmedAt: timestamp("last_confirmed_at"),
  createdAt: timestamp("created_at").defaultNow(), updatedAt: timestamp("updated_at").defaultNow(),
}, table => [index("food_business_appearances_profile_date_idx").on(table.restaurantId, table.profileType, table.date)]);
