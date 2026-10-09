CREATE TABLE "app_commissions" (
	"room_code" varchar(4) NOT NULL,
	"match_id" integer NOT NULL,
	"credits" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_commissions_room_code_match_id_pk" PRIMARY KEY("room_code","match_id")
);
--> statement-breakpoint
CREATE TABLE "match_settlements" (
	"room_code" varchar(4) NOT NULL,
	"match_id" integer NOT NULL,
	"winning_colonies" integer[] NOT NULL,
	"pool_credits" integer NOT NULL,
	"commission_credits" integer NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_settlements_room_code_match_id_pk" PRIMARY KEY("room_code","match_id")
);
--> statement-breakpoint
CREATE TABLE "match_wagers" (
	"participant_id" uuid NOT NULL,
	"room_code" varchar(4) NOT NULL,
	"match_id" integer NOT NULL,
	"colony" integer NOT NULL,
	"amount" integer NOT NULL,
	"payout_credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "match_wagers_participant_id_room_code_match_id_pk" PRIMARY KEY("participant_id","room_code","match_id"),
	CONSTRAINT "match_wagers_minimum_amount" CHECK ("match_wagers"."amount" >= 20),
	CONSTRAINT "match_wagers_positive_colony" CHECK ("match_wagers"."colony" > 0)
);
--> statement-breakpoint
ALTER TABLE "match_wagers" ADD CONSTRAINT "match_wagers_participant_id_users_id_fk" FOREIGN KEY ("participant_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE public.match_wagers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_commissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.match_wagers, public.match_settlements, public.app_commissions FROM anon, authenticated;
GRANT ALL ON public.match_wagers, public.match_settlements, public.app_commissions TO service_role;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.place_match_wager(
  p_participant_id uuid,
  p_room_code text,
  p_match_id integer,
  p_colony integer,
  p_amount integer
)
RETURNS TABLE(available_credits integer, wager_amount integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous integer := 0;
  v_balance integer;
BEGIN
  IF p_amount < 20 OR p_room_code !~ '^[A-Z0-9]{4}$' OR p_match_id < 1 OR p_colony < 1 THEN
    RAISE EXCEPTION 'Invalid wager';
  END IF;

  SELECT c.credits INTO v_balance
    FROM public.participant_credits c
    WHERE c.participant_id = p_participant_id
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit account not found'; END IF;

  SELECT w.amount INTO v_previous
    FROM public.match_wagers w
    WHERE w.participant_id = p_participant_id
      AND w.room_code = p_room_code
      AND w.match_id = p_match_id
      AND w.settled_at IS NULL
    FOR UPDATE;
  v_previous := COALESCE(v_previous, 0);

  IF p_amount > v_balance + v_previous THEN RAISE EXCEPTION 'Insufficient credits'; END IF;

  UPDATE public.participant_credits c
    SET credits = c.credits + v_previous - p_amount,
        updated_at = now()
    WHERE c.participant_id = p_participant_id
    RETURNING c.credits INTO v_balance;

  INSERT INTO public.match_wagers (participant_id, room_code, match_id, colony, amount)
    VALUES (p_participant_id, p_room_code, p_match_id, p_colony, p_amount)
    ON CONFLICT (participant_id, room_code, match_id)
    DO UPDATE SET colony = EXCLUDED.colony, amount = EXCLUDED.amount, created_at = now();

  RETURN QUERY SELECT v_balance, p_amount;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.settle_match_wagers(
  p_room_code text,
  p_match_id integer,
  p_winning_colonies integer[],
  p_territory_percentages jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pool integer := 0;
  v_payout integer := 0;
  v_commission integer := 0;
  v_winning_weight numeric := 0;
  v_winner_count integer := 0;
  v_rows integer := 0;
BEGIN
  INSERT INTO public.match_settlements (room_code, match_id, winning_colonies, pool_credits, commission_credits)
    VALUES (p_room_code, p_match_id, COALESCE(p_winning_colonies, ARRAY[]::integer[]), 0, 0)
    ON CONFLICT (room_code, match_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE EXCEPTION 'Match already settled'; END IF;

  PERFORM 1 FROM public.match_wagers w
    WHERE w.room_code = p_room_code AND w.match_id = p_match_id AND w.settled_at IS NULL
    FOR UPDATE;
  SELECT COALESCE(sum(w.amount), 0)::integer INTO v_pool
    FROM public.match_wagers w
    WHERE w.room_code = p_room_code AND w.match_id = p_match_id AND w.settled_at IS NULL;

  SELECT count(*)::integer,
         COALESCE(sum(w.amount::numeric * GREATEST(0, COALESCE((p_territory_percentages ->> w.colony::text)::numeric, 0))), 0)
    INTO v_winner_count, v_winning_weight
    FROM public.match_wagers w
    WHERE w.room_code = p_room_code AND w.match_id = p_match_id
      AND w.settled_at IS NULL AND w.colony = ANY(COALESCE(p_winning_colonies, ARRAY[]::integer[]));

  IF v_pool = 0 THEN
    v_payout := 0;
  ELSIF v_winner_count = 0 OR v_winning_weight <= 0 THEN
    UPDATE public.match_wagers w
      SET payout_credits = w.amount, settled_at = now()
      WHERE w.room_code = p_room_code AND w.match_id = p_match_id AND w.settled_at IS NULL;
    UPDATE public.participant_credits c
      SET credits = c.credits + w.amount, updated_at = now()
      FROM public.match_wagers w
      WHERE w.participant_id = c.participant_id AND w.room_code = p_room_code
        AND w.match_id = p_match_id AND w.payout_credits = w.amount AND w.settled_at IS NOT NULL;
    v_payout := v_pool;
  ELSE
    v_commission := round(v_pool * 0.10)::integer;
    v_payout := v_pool - v_commission;

    WITH weighted AS (
      SELECT w.participant_id, w.amount::numeric * GREATEST(0, COALESCE((p_territory_percentages ->> w.colony::text)::numeric, 0)) AS weight
      FROM public.match_wagers w
      WHERE w.room_code = p_room_code AND w.match_id = p_match_id
        AND w.settled_at IS NULL AND w.colony = ANY(p_winning_colonies)
    ), raw_shares AS (
      SELECT participant_id, (weight * v_payout / v_winning_weight) AS raw_share
      FROM weighted
    ), ranked AS (
      SELECT participant_id, floor(raw_share)::integer AS base_share,
        row_number() OVER (ORDER BY (raw_share - floor(raw_share)) DESC, participant_id) AS remainder_rank,
        v_payout - sum(floor(raw_share)::integer) OVER () AS remainder_count
      FROM raw_shares
    )
    UPDATE public.match_wagers w
      SET payout_credits = r.base_share + CASE WHEN r.remainder_rank <= r.remainder_count THEN 1 ELSE 0 END,
          settled_at = now()
      FROM ranked r
      WHERE w.participant_id = r.participant_id AND w.room_code = p_room_code AND w.match_id = p_match_id;

    UPDATE public.match_wagers w SET settled_at = now()
      WHERE w.room_code = p_room_code AND w.match_id = p_match_id AND w.settled_at IS NULL;
    UPDATE public.participant_credits c
      SET credits = c.credits + w.payout_credits, updated_at = now()
      FROM public.match_wagers w
      WHERE w.participant_id = c.participant_id AND w.room_code = p_room_code
        AND w.match_id = p_match_id AND w.payout_credits > 0;
  END IF;

  UPDATE public.match_settlements s
    SET pool_credits = v_pool, commission_credits = v_commission
    WHERE s.room_code = p_room_code AND s.match_id = p_match_id;
  INSERT INTO public.app_commissions (room_code, match_id, credits)
    VALUES (p_room_code, p_match_id, v_commission)
    ON CONFLICT (room_code, match_id) DO NOTHING;

  RETURN jsonb_build_object('pool', v_pool, 'payout', v_payout, 'winners', v_winner_count);
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.place_match_wager(uuid, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_match_wagers(text, integer, integer[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_match_wager(uuid, text, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_match_wagers(text, integer, integer[], jsonb) TO service_role;
