import { index, integer, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { ownerAiActionDrafts, restaurants, users } from "./legacy";
export const reverseOsmosisOperations = pgTable("reverse_osmosis_operations", {
  operationKey: varchar("operation_key", { length: 64 }).primaryKey(),
  payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
  draftId: varchar("draft_id").notNull().references(() => ownerAiActionDrafts.id, { onDelete: "cascade" }),
  restaurantId: varchar("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
  ownerId: varchar("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  approvedRevision: integer("approved_revision").notNull(),
  approvalId: varchar("approval_id", { length: 512 }).notNull(),
  proposal: jsonb("proposal").notNull(),
  status: varchar("status").notNull(),
  receipt: jsonb("receipt"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, table => [index("reverse_osmosis_operations_owner_draft_idx").on(table.ownerId, table.draftId)]);
