import { beforeEach, describe, expect, it } from "vitest";
import {
	type AgentRow,
	type AllowRuleRow,
	type AuditLogRow,
	agentFromRow,
	allowRuleFromRow,
	auditLogEntryFromRow,
	type CategoryRow,
	categoryFromRow,
	getDb,
	insertAgent,
	insertAllowRule,
	insertAuditLogEntry,
	insertCategory,
	insertMessage,
	insertToken,
	type MessageRow,
	messageFromRow,
	newId,
	type TokenRow,
	tokenFromRow,
} from "../../src/db";
import type {
	Agent,
	AllowRule,
	Message,
	NewAuditLogEntry,
	Token,
} from "../../src/types";
import { createTestDb } from "../helpers/db";
import { DAY_MS, seedAgent, seedCategory, T0 } from "../helpers/fixtures";

let db: D1Database;

beforeEach(async () => {
	db = await createTestDb();
});

function question(
	from: Agent,
	to: Agent,
	categoryId: string,
	overrides: Partial<Message> = {},
): Message {
	return {
		id: newId(),
		kind: "question",
		fromAgentId: from.id,
		toAgentId: to.id,
		categoryId,
		body: "When is the dentist appointment?",
		inReplyTo: null,
		status: "pending",
		createdAt: T0,
		receivedAt: null,
		expiresAt: T0 + 7 * DAY_MS,
		bodyDeletedAt: null,
		...overrides,
	};
}

function reply(to: Message, overrides: Partial<Message> = {}): Message {
	return {
		id: newId(),
		kind: "answer",
		fromAgentId: to.toAgentId,
		toAgentId: to.fromAgentId,
		categoryId: to.categoryId,
		body: "Tuesday at 10.",
		inReplyTo: to.id,
		status: "sent",
		createdAt: T0 + 1,
		receivedAt: null,
		expiresAt: null,
		bodyDeletedAt: null,
		...overrides,
	};
}

async function queryPlan(sql: string, ...params: unknown[]): Promise<string> {
	const { results } = await db
		.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.bind(...params)
		.all<{ detail: string }>();
	return results.map((row) => row.detail).join("\n");
}

describe("test database helper", () => {
	it("applies the migrations and starts every table empty", async () => {
		const { results } = await db
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
			)
			.all<{ name: string }>();
		const tables = results.map((row) => row.name);
		expect(tables).toEqual([
			"agents",
			"allow_rules",
			"audit_log",
			"categories",
			"messages",
			"tokens",
		]);
		for (const table of tables) {
			const count = await db
				.prepare(`SELECT COUNT(*) AS n FROM ${table}`)
				.first<{ n: number }>();
			expect(count?.n).toBe(0);
		}
	});

	it("hands out the database bound to the Worker", async () => {
		expect(getDb({ DB: db })).toBe(db);
	});
});

describe("agents", () => {
	it("stores and returns an agent", async () => {
		const agent: Agent = {
			id: newId(),
			ownerId: "owner-1",
			name: "calendar",
			description: "Knows the schedule.",
			status: "suspended",
			dailyQuestionLimit: 5,
			createdAt: T0,
		};
		await insertAgent(db, agent).run();

		const row = await db
			.prepare("SELECT * FROM agents WHERE id = ?")
			.bind(agent.id)
			.first<AgentRow>();
		expect(row && agentFromRow(row)).toEqual(agent);
	});

	it("rejects a duplicate name", async () => {
		await seedAgent(db, { name: "calendar" });
		await expect(seedAgent(db, { name: "calendar" })).rejects.toThrow(/UNIQUE/);
	});

	it("rejects an unknown status", async () => {
		await expect(
			seedAgent(db, { status: "deleted" as Agent["status"] }),
		).rejects.toThrow(/CHECK/);
	});
});

describe("tokens", () => {
	function token(agent: Agent, overrides: Partial<Token> = {}): Token {
		return {
			id: newId(),
			agentId: agent.id,
			tokenHash: `hash-${newId()}`,
			purpose: "participant",
			createdAt: T0,
			revokedAt: null,
			...overrides,
		};
	}

	it("stores and returns a token", async () => {
		const agent = await seedAgent(db);
		const stored = token(agent, { revokedAt: T0 + 1 });
		await insertToken(db, stored).run();

		const row = await db
			.prepare("SELECT * FROM tokens WHERE token_hash = ?")
			.bind(stored.tokenHash)
			.first<TokenRow>();
		expect(row && tokenFromRow(row)).toEqual(stored);
	});

	it("has no column for the token plaintext", async () => {
		const { results } = await db
			.prepare("SELECT name FROM pragma_table_info('tokens') ORDER BY cid")
			.all<{ name: string }>();
		expect(results.map((row) => row.name)).toEqual([
			"id",
			"agent_id",
			"token_hash",
			"purpose",
			"created_at",
			"revoked_at",
		]);
	});

	it("allows one valid token per agent and purpose", async () => {
		const agent = await seedAgent(db);
		const first = token(agent);
		await insertToken(db, first).run();

		await expect(insertToken(db, token(agent)).run()).rejects.toThrow(/UNIQUE/);
		await insertToken(db, token(agent, { purpose: "unread_count" })).run();

		// Reissue: revoke the old token and insert the new one in one batch.
		await db.batch([
			db
				.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
				.bind(T0 + 1, first.id),
			insertToken(db, token(agent, { createdAt: T0 + 1 })),
		]);
		const valid = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM tokens WHERE agent_id = ? AND purpose = 'participant' AND revoked_at IS NULL",
			)
			.bind(agent.id)
			.first<{ n: number }>();
		expect(valid?.n).toBe(1);
	});

	it("rejects a token for an agent that does not exist", async () => {
		const ghost = { id: newId() } as Agent;
		await expect(insertToken(db, token(ghost)).run()).rejects.toThrow(
			/FOREIGN KEY/,
		);
	});
});

describe("categories", () => {
	it("stores and returns a category", async () => {
		const category = { id: newId(), name: "予定" };
		await insertCategory(db, category).run();

		const row = await db
			.prepare("SELECT * FROM categories WHERE name = ?")
			.bind("予定")
			.first<CategoryRow>();
		expect(row && categoryFromRow(row)).toEqual(category);
	});

	it("rejects a duplicate name", async () => {
		await seedCategory(db, { name: "予定" });
		await expect(seedCategory(db, { name: "予定" })).rejects.toThrow(/UNIQUE/);
	});
});

describe("allow_rules", () => {
	it("stores and returns a rule", async () => {
		const a = await seedAgent(db);
		const b = await seedAgent(db);
		const category = await seedCategory(db);
		const rule: AllowRule = {
			fromAgentId: a.id,
			toAgentId: b.id,
			categoryId: category.id,
			createdAt: T0,
		};
		await insertAllowRule(db, rule).run();

		const { results } = await db
			.prepare("SELECT * FROM allow_rules WHERE from_agent_id = ?")
			.bind(a.id)
			.all<AllowRuleRow>();
		expect(results.map(allowRuleFromRow)).toEqual([rule]);
	});

	it("rejects a duplicate rule and a rule from an agent to itself", async () => {
		const a = await seedAgent(db);
		const b = await seedAgent(db);
		const category = await seedCategory(db);
		const rule: AllowRule = {
			fromAgentId: a.id,
			toAgentId: b.id,
			categoryId: category.id,
			createdAt: T0,
		};
		await insertAllowRule(db, rule).run();

		await expect(insertAllowRule(db, rule).run()).rejects.toThrow(/UNIQUE/);
		await expect(
			insertAllowRule(db, { ...rule, toAgentId: a.id }).run(),
		).rejects.toThrow(/CHECK/);
	});
});

describe("messages", () => {
	let a: Agent;
	let b: Agent;
	let categoryId: string;

	beforeEach(async () => {
		a = await seedAgent(db);
		b = await seedAgent(db);
		categoryId = (await seedCategory(db)).id;
	});

	async function load(id: string): Promise<Message | null> {
		const row = await db
			.prepare("SELECT * FROM messages WHERE id = ?")
			.bind(id)
			.first<MessageRow>();
		return row && messageFromRow(row);
	}

	it("stores and returns a question and its answer", async () => {
		const q = question(a, b, categoryId, { receivedAt: T0 + 5 });
		const answer = reply(q, { bodyDeletedAt: T0 + DAY_MS, body: null });
		await db.batch([insertMessage(db, q), insertMessage(db, answer)]);

		expect(await load(q.id)).toEqual(q);
		expect(await load(answer.id)).toEqual(answer);
	});

	it("stores a blocked question without a recipient or category, and its rejection", async () => {
		const blocked = question(a, b, categoryId, {
			toAgentId: null,
			categoryId: null,
			status: "blocked",
			body: null,
			expiresAt: null,
		});
		const rejection = reply(blocked, { kind: "rejection", body: null });
		await db.batch([insertMessage(db, blocked), insertMessage(db, rejection)]);

		expect(await load(blocked.id)).toEqual(blocked);
		expect(await load(rejection.id)).toEqual(rejection);
	});

	it("allows only one reply per question", async () => {
		const q = question(a, b, categoryId);
		await insertMessage(db, q).run();
		await insertMessage(db, reply(q)).run();

		await expect(
			insertMessage(db, reply(q, { kind: "rejection", body: null })).run(),
		).rejects.toThrow(/UNIQUE/);
	});

	it("rejects rows whose kind, status and references disagree", async () => {
		const q = question(a, b, categoryId);
		await insertMessage(db, q).run();

		const invalid: Message[] = [
			question(a, b, categoryId, { status: "sent" }),
			question(a, b, categoryId, { inReplyTo: q.id }),
			question(a, b, categoryId, { toAgentId: null }),
			question(a, b, categoryId, { categoryId: null }),
			question(a, b, categoryId, { expiresAt: null }),
			question(a, b, categoryId, { fromAgentId: null }),
			reply(q, { status: "pending" }),
			reply(q, { inReplyTo: null }),
			reply(q, { fromAgentId: null }),
			reply(q, { kind: "memo" as Message["kind"] }),
		];
		for (const message of invalid) {
			await expect(insertMessage(db, message).run()).rejects.toThrow(/CHECK/);
		}
	});

	it("finds an inbox through the inbox index", async () => {
		const delivered = question(a, b, categoryId, { receivedAt: T0 + 1 });
		const waiting = question(a, b, categoryId, { createdAt: T0 + 2 });
		const blocked = question(a, b, categoryId, { status: "blocked" });
		const elsewhere = question(b, a, categoryId);
		await db.batch(
			[delivered, waiting, blocked, elsewhere].map((m) => insertMessage(db, m)),
		);

		const sql =
			"SELECT * FROM messages WHERE to_agent_id = ? AND status IN ('pending', 'sent') AND received_at IS NULL ORDER BY created_at";
		const { results } = await db.prepare(sql).bind(b.id).all<MessageRow>();
		expect(results.map((row) => row.id)).toEqual([waiting.id]);
		expect(await queryPlan(sql, b.id)).toContain("messages_inbox_idx");
	});

	it("counts a sender's questions per UTC day, blocked ones included", async () => {
		const dayStart = T0;
		const dayEnd = T0 + DAY_MS;
		const inDay = [
			question(a, b, categoryId, { createdAt: dayStart }),
			question(a, b, categoryId, {
				createdAt: dayEnd - 1,
				status: "blocked",
				toAgentId: null,
				categoryId: null,
				body: null,
				expiresAt: null,
			}),
		];
		const outside = [
			question(a, b, categoryId, { createdAt: dayStart - 1 }),
			question(a, b, categoryId, { createdAt: dayEnd }),
			question(b, a, categoryId, { createdAt: dayStart }),
		];
		// An answer written by the same agent on the same day is not a question.
		const answer = reply(outside[2] as Message, { createdAt: dayStart + 1 });
		await db.batch(
			[...inDay, ...outside, answer].map((m) => insertMessage(db, m)),
		);

		const sql =
			"SELECT COUNT(*) AS n FROM messages WHERE kind = 'question' AND from_agent_id = ? AND created_at >= ? AND created_at < ?";
		const count = await db
			.prepare(sql)
			.bind(a.id, dayStart, dayEnd)
			.first<{ n: number }>();
		expect(count?.n).toBe(2);
		expect(await queryPlan(sql, a.id, dayStart, dayEnd)).toContain(
			"messages_daily_questions_idx",
		);
	});

	it("finds questions past their deadline through the expiry index", async () => {
		const due = question(a, b, categoryId, { expiresAt: T0 + 7 * DAY_MS });
		const notYet = question(a, b, categoryId, {
			expiresAt: T0 + 7 * DAY_MS + 1,
		});
		const answered = question(a, b, categoryId, { status: "answered" });
		await db.batch([due, notYet, answered].map((m) => insertMessage(db, m)));

		const sql =
			"SELECT id FROM messages WHERE status = 'pending' AND expires_at <= ?";
		const now = T0 + 7 * DAY_MS;
		const { results } = await db.prepare(sql).bind(now).all<{ id: string }>();
		expect(results.map((row) => row.id)).toEqual([due.id]);
		expect(await queryPlan(sql, now)).toContain("messages_expiry_idx");
	});
});

describe("audit_log", () => {
	function entry(overrides: Partial<NewAuditLogEntry> = {}): NewAuditLogEntry {
		return {
			occurredAt: T0,
			eventType: "question_accepted",
			fromAgentId: "agent-a",
			toAgentId: "agent-b",
			categoryId: "category-1",
			outcome: "ok",
			reasonCode: null,
			messageId: "message-1",
			body: null,
			...overrides,
		};
	}

	it("stores and returns entries in insertion order", async () => {
		const accepted = entry();
		const blocked = entry({
			eventType: "question_blocked",
			outcome: "denied",
			reasonCode: "no_allow_rule",
			body: "recorded only when enabled",
		});
		const authFailed = entry({
			eventType: "auth_failed",
			fromAgentId: null,
			toAgentId: null,
			categoryId: null,
			outcome: "denied",
			reasonCode: "token_unknown",
			messageId: null,
		});
		const first = await insertAuditLogEntry(db, accepted).run();
		await db.batch([
			insertAuditLogEntry(db, blocked),
			insertAuditLogEntry(db, authFailed),
		]);

		const { results } = await db
			.prepare(
				"SELECT * FROM audit_log WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at, id",
			)
			.bind(T0, T0 + 1)
			.all<AuditLogRow>();
		const entries = results.map(auditLogEntryFromRow);
		expect(entries.map(({ id: _id, ...rest }) => rest)).toEqual([
			accepted,
			blocked,
			authFailed,
		]);
		expect(entries[0]?.id).toBe(first.meta.last_row_id);
		expect(entries[1]?.id).toBeGreaterThan(entries[0]?.id as number);
	});

	it("keeps entries about agents that do not exist", async () => {
		await insertAuditLogEntry(db, entry({ fromAgentId: newId() })).run();
		const count = await db
			.prepare("SELECT COUNT(*) AS n FROM audit_log")
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
	});
});

describe("deletion", () => {
	let a: Agent;
	let b: Agent;
	let categoryId: string;

	beforeEach(async () => {
		a = await seedAgent(db, { name: "a" });
		b = await seedAgent(db, { name: "b" });
		categoryId = (await seedCategory(db, { name: "schedule" })).id;
	});

	async function messageCount(): Promise<number> {
		const row = await db
			.prepare("SELECT COUNT(*) AS n FROM messages")
			.first<{ n: number }>();
		return row?.n ?? -1;
	}

	it("deletes an agent that has messages, taking their messages and replies", async () => {
		const asked = question(a, b, categoryId);
		const answer = reply(asked);
		const received = question(b, a, categoryId);
		await db.batch([asked, answer, received].map((m) => insertMessage(db, m)));
		await insertAuditLogEntry(db, {
			occurredAt: T0,
			eventType: "question_accepted",
			fromAgentId: a.id,
			toAgentId: b.id,
			categoryId,
			outcome: "ok",
			reasonCode: null,
			messageId: asked.id,
			body: null,
		}).run();
		expect(await messageCount()).toBe(3);

		await db.prepare("DELETE FROM agents WHERE id = ?").bind(a.id).run();

		expect(await messageCount()).toBe(0);
		// The audit log survives, by design without foreign keys.
		const audit = await db
			.prepare("SELECT COUNT(*) AS n FROM audit_log")
			.first<{ n: number }>();
		expect(audit?.n).toBe(1);
		// The other agent is untouched.
		const survivors = await db
			.prepare("SELECT COUNT(*) AS n FROM agents")
			.first<{ n: number }>();
		expect(survivors?.n).toBe(1);
	});

	it("removes a bridge rejection with the question it refers to", async () => {
		const asked = question(b, a, categoryId);
		const rejection = reply(asked, {
			kind: "rejection",
			fromAgentId: null,
			body: null,
		});
		await db.batch([asked, rejection].map((m) => insertMessage(db, m)));

		// The rejection names neither the deleted agent nor its category;
		// only in_reply_to ties it to the deleted question.
		await db.prepare("DELETE FROM agents WHERE id = ?").bind(a.id).run();

		expect(await messageCount()).toBe(0);
	});

	it("deletes a category that has messages", async () => {
		const asked = question(a, b, categoryId);
		const expired = question(a, b, categoryId, { status: "expired" });
		await db.batch([asked, expired].map((m) => insertMessage(db, m)));

		await db
			.prepare("DELETE FROM categories WHERE id = ?")
			.bind(categoryId)
			.run();

		expect(await messageCount()).toBe(0);
		const agents = await db
			.prepare("SELECT COUNT(*) AS n FROM agents")
			.first<{ n: number }>();
		expect(agents?.n).toBe(2);
	});
});

describe("row conversion", () => {
	it("throws on a stored value outside the known set", async () => {
		await db
			.prepare(
				"INSERT INTO audit_log (occurred_at, event_type, outcome) VALUES (?, 'made_up_event', 'ok')",
			)
			.bind(T0)
			.run();
		const row = await db
			.prepare("SELECT * FROM audit_log")
			.first<AuditLogRow>();
		expect(() => auditLogEntryFromRow(row as AuditLogRow)).toThrow(
			/audit_log\.event_type/,
		);
	});
});
