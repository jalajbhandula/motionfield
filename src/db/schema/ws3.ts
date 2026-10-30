// WS3 schema extension point - additive tables for workstream 3 live here.
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Per-user acknowledgment of restricted-weight license terms (e.g. LTX-Video
 *  Open RAIL-M). One row = the user opted in to the current LICENSE_VERSION. */
export const licenseOptins = pgTable("license_optins", {
  userId: text("user_id").primaryKey(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  version: text("version").notNull(),
});
