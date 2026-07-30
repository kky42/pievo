DROP INDEX "machines_team_idx";
--> statement-breakpoint
DROP INDEX "loops_team_idx";
--> statement-breakpoint
ALTER TABLE "machines" DROP COLUMN "team_id";
--> statement-breakpoint
ALTER TABLE "loops" DROP COLUMN "team_id";
--> statement-breakpoint
ALTER TABLE "connect_keys" DROP COLUMN "team_id";
--> statement-breakpoint
DROP TABLE "team_invites";
--> statement-breakpoint
DROP TABLE "team_members";
--> statement-breakpoint
DROP TABLE "teams";
