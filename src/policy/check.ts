import type { AgentRow, CategoryRow } from "../db";
import type { ReasonCode, UnixMillis } from "../types";

export const UTC_DAY_MS = 24 * 60 * 60 * 1000;

/** The reasons the policy check itself can give for a denial. */
export type PolicyReasonCode = Extract<
	ReasonCode,
	| "sender_suspended"
	| "recipient_not_found"
	| "self_addressed"
	| "recipient_suspended"
	| "category_not_found"
	| "no_allow_rule"
	| "daily_limit_exceeded"
>;

export interface QuestionCheckInput {
	/** The sender, as resolved from its token. Never taken from tool input. */
	fromAgentId: string;
	/** The recipient name as given to `ask`. Matched exactly. */
	toAgentName: string;
	/** The category name as given to `ask`. Matched exactly. */
	categoryName: string;
	/** The current time. Decides which UTC day the daily limit looks at. */
	now: UnixMillis;
}

/**
 * The outcome of a policy check.
 *
 * `toAgentId` and `categoryId` are the IDs the given names resolved to. On a
 * denial they are filled in whenever the name exists, whatever the reason,
 * so that the blocked message row and the audit log can refer to them. They
 * are null only when the name does not exist.
 *
 * `reasonCode` is for the audit log only. It must never reach the asking
 * agent (design 3.4).
 */
export type QuestionDecision =
	| { allowed: true; toAgentId: string; categoryId: string }
	| {
			allowed: false;
			reasonCode: PolicyReasonCode;
			toAgentId: string | null;
			categoryId: string | null;
	  };

/** Returns the start of the UTC day that contains `now`. */
export function utcDayStart(now: UnixMillis): UnixMillis {
	return Math.floor(now / UTC_DAY_MS) * UTC_DAY_MS;
}

/**
 * Counts the questions an agent sent on the UTC day that contains `now`,
 * including the ones the bridge blocked. Returned unexecuted so that it can
 * join a `db.batch([...])`; the single result row is `{ count: number }`.
 */
export function countDailyQuestions(
	db: D1Database,
	fromAgentId: string,
	now: UnixMillis,
): D1PreparedStatement {
	const dayStart = utcDayStart(now);
	return db
		.prepare(
			`SELECT COUNT(*) AS count FROM messages
			WHERE kind = 'question' AND from_agent_id = ?
				AND created_at >= ? AND created_at < ?`,
		)
		.bind(fromAgentId, dayStart, dayStart + UTC_DAY_MS);
}

/**
 * Decides whether the bridge lets a question through (design 3.1, 3.6).
 *
 * When several denial conditions hold, the first of these wins:
 *   1. sender_suspended
 *   2. recipient_not_found
 *   3. self_addressed
 *   4. recipient_suspended
 *   5. category_not_found
 *   6. no_allow_rule
 *   7. daily_limit_exceeded
 *
 * This function only reads. The daily limit compares the sender's existing
 * questions on the current UTC day against `daily_question_limit`, and
 * `submitQuestion` enforces the same bound atomically when inserting so
 * concurrent `ask` calls cannot exceed it.
 *
 * Throws if `fromAgentId` does not exist, since the sender comes from
 * authentication and not from the caller's input.
 */
export async function checkQuestion(
	db: D1Database,
	input: QuestionCheckInput,
): Promise<QuestionDecision> {
	const { fromAgentId, toAgentName, categoryName, now } = input;

	// One batch, so that every condition is judged on the same snapshot.
	const [senders, recipients, categories, rules, counts] = await db.batch([
		db.prepare("SELECT * FROM agents WHERE id = ?").bind(fromAgentId),
		db.prepare("SELECT * FROM agents WHERE name = ?").bind(toAgentName),
		db.prepare("SELECT * FROM categories WHERE name = ?").bind(categoryName),
		db
			.prepare(
				`SELECT 1 AS found FROM allow_rules r
				JOIN agents a ON a.id = r.to_agent_id
				JOIN categories c ON c.id = r.category_id
				WHERE r.from_agent_id = ? AND a.name = ? AND c.name = ?`,
			)
			.bind(fromAgentId, toAgentName, categoryName),
		countDailyQuestions(db, fromAgentId, now),
	]);

	const sender = (senders?.results[0] ?? null) as AgentRow | null;
	const recipient = (recipients?.results[0] ?? null) as AgentRow | null;
	const category = (categories?.results[0] ?? null) as CategoryRow | null;
	const hasRule = (rules?.results.length ?? 0) > 0;
	const count = (counts?.results[0] as { count: number } | undefined)?.count;

	if (sender === null) {
		throw new Error(`Unknown sender agent: ${fromAgentId}`);
	}
	if (count === undefined) {
		throw new Error("Daily question count query returned no row");
	}

	const toAgentId = recipient?.id ?? null;
	const categoryId = category?.id ?? null;
	const deny = (reasonCode: PolicyReasonCode): QuestionDecision => ({
		allowed: false,
		reasonCode,
		toAgentId,
		categoryId,
	});

	if (sender.status !== "active") return deny("sender_suspended");
	if (recipient === null) return deny("recipient_not_found");
	if (recipient.id === sender.id) return deny("self_addressed");
	if (recipient.status !== "active") return deny("recipient_suspended");
	if (category === null) return deny("category_not_found");
	if (!hasRule) return deny("no_allow_rule");
	if (count >= sender.daily_question_limit) {
		return deny("daily_limit_exceeded");
	}
	return { allowed: true, toAgentId: recipient.id, categoryId: category.id };
}
