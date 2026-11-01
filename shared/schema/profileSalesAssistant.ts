import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const profileSalesAssistantConfigs = pgTable(
  "profile_sales_assistant_configs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    profileKind: varchar("profile_kind").notNull(),
    profileId: varchar("profile_id").notNull(),
    contractVersion: varchar("contract_version")
      .notNull()
      .default("mealscout.profile-sales-assistant.v1"),
    enabled: boolean("enabled").notNull().default(true),
    solicitationGuard: boolean("solicitation_guard").notNull().default(true),
    marketingOptInDefault: boolean("marketing_opt_in_default")
      .notNull()
      .default(false),
    quotePolicy: varchar("quote_policy").notNull().default("listed_items_only"),
    defaults: jsonb("defaults").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_profile_sales_assistant_profile").on(
      table.profileKind,
      table.profileId,
    ),
    index("idx_profile_sales_assistant_kind").on(table.profileKind),
  ],
);

export const profileSalesInquiries = pgTable(
  "profile_sales_inquiries",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    configId: varchar("config_id")
      .notNull()
      .references(() => profileSalesAssistantConfigs.id, {
        onDelete: "cascade",
      }),
    profileKind: varchar("profile_kind").notNull(),
    profileId: varchar("profile_id").notNull(),
    qualification: jsonb("qualification").notNull(),
    quote: jsonb("quote").notNull(),
    completion: jsonb("completion").notNull(),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    customerName: varchar("customer_name"),
    customerEmail: varchar("customer_email"),
    customerPhone: varchar("customer_phone"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_profile_sales_inquiries_profile").on(
      table.profileKind,
      table.profileId,
    ),
  ],
);
