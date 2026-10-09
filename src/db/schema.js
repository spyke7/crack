import { pgSchema, pgTable, uuid, integer, timestamp, varchar, check, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const auth = pgSchema('auth');
const authUsers = auth.table('users', { id: uuid('id').primaryKey() });

export const participantCredits = pgTable('participant_credits', {
  participantId: uuid('participant_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  credits: integer('credits').notNull().default(100),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [check('participant_credits_nonnegative', sql`${table.credits} >= 0`)]);

export const matchWagers = pgTable('match_wagers', {
  participantId: uuid('participant_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  roomCode: varchar('room_code', { length: 4 }).notNull(),
  matchId: integer('match_id').notNull(),
  colony: integer('colony').notNull(),
  amount: integer('amount').notNull(),
  payoutCredits: integer('payout_credits').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, table => [
  primaryKey({ columns: [table.participantId, table.roomCode, table.matchId] }),
  check('match_wagers_minimum_amount', sql`${table.amount} >= 20`),
  check('match_wagers_positive_colony', sql`${table.colony} > 0`),
]);

export const matchSettlements = pgTable('match_settlements', {
  roomCode: varchar('room_code', { length: 4 }).notNull(),
  matchId: integer('match_id').notNull(),
  winningColonies: integer('winning_colonies').array().notNull(),
  poolCredits: integer('pool_credits').notNull(),
  commissionCredits: integer('commission_credits').notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.roomCode, table.matchId] })]);

export const appCommissions = pgTable('app_commissions', {
  roomCode: varchar('room_code', { length: 4 }).notNull(),
  matchId: integer('match_id').notNull(),
  credits: integer('credits').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.roomCode, table.matchId] })]);
