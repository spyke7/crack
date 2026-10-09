CREATE TABLE IF NOT EXISTS "participant_credits" (
  "participant_id" uuid PRIMARY KEY NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "credits" integer DEFAULT 100 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "participant_credits_nonnegative" CHECK ("credits" >= 0)
);
--> statement-breakpoint

ALTER TABLE "participant_credits" ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE "participant_credits" TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE "participant_credits" FROM anon, authenticated;
--> statement-breakpoint

DROP POLICY IF EXISTS "Participants can read their own credits" ON public.participant_credits;
CREATE POLICY "Participants can read their own credits"
  ON "participant_credits" FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = "participant_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.create_participant_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.participant_credits (participant_id, credits)
  VALUES (NEW.id, 100)
  ON CONFLICT (participant_id) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS on_auth_user_created_credits ON auth.users;
CREATE TRIGGER on_auth_user_created_credits
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.create_participant_credits();
