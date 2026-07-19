CREATE TABLE "team_invites" (
	"token" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"expires_at" text NOT NULL,
	"redeemed_at" text,
	"redeemed_by_user_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "team_invites_team_idx" ON "team_invites" USING btree ("team_id");