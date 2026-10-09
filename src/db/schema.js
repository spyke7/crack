import { pgSchema, pgTable, uuid, integer, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const auth = pgSchema('auth');
const authUsers = auth.table('users', { id: uuid('id').primaryKey() });

export const participantCredits = pgTable('participant_credits', {
  participantId: uuid('participant_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  credits: integer('credits').notNull().default(100),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [check('participant_credits_nonnegative', sql`${table.credits} >= 0`)]);
