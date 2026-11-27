import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type AdminBotConfigRow,
	type AgentRow,
	type AllowRuleRow,
	type AuditLogRow,
	adminBotConfigFromRow,
	agentFromRow,
	allowRuleFromRow,
	auditLogEntryFromRow,
	type CategoryRow,
	type ChangeLogRow,
	categoryFromRow,
	changeLogEntryFromRow,
	getDb,
	insertAgent,
	insertAllowRule,
	insertAuditLogEntry,
	insertCategory,
	insertChangeLogEntry,
	insertMessage,
	insertProposal,
	insertToken,
	type MessageRow,
	messageFromRow,
	newId,
	type ProposalRow,
	parseProposalPayload,
	proposalFromRow,
	type TokenRow,
	tokenFromRow,
} from "../../src/db";
import type {
	Agent,
	AllowRule,
	Message,
	NewAuditLogEntry,
	NewChangeLogEntry,
	Proposal,
	Token,
} from "../../src/types";
import { createTestDb, migrationByName } from "../helpers/db";
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
			"admin_bot_config",
			"agents",
			"allow_rules",
			"audit_log",
			"categories",
			"change_log",
			"messages",
			"proposals",
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

describe("change_log", () => {
	function entry(
		overrides: Partial<NewChangeLogEntry> = {},
	): NewChangeLogEntry {
		return {
			occurredAt: T0,
			actorType: "owner",
			actorId: "me",
			approverId: null,
			action: "agent_registered",
			targetType: "agent",
			targetId: "agent-1",
			beforeJson: null,
			afterJson: '{"name":"muse"}',
			revertedAt: null,
			...overrides,
		};
	}

	it("stores and returns entries newest first using the time index", async () => {
		const first = await insertChangeLogEntry(db, entry()).run();
		await db.batch([
			insertChangeLogEntry(
				db,
				entry({
					occurredAt: T0,
					actorType: "admin_bot",
					actorId: "bot-1",
					approverId: "me",
					action: "allow_rule_granted",
					targetType: "allow_rule",
					targetId: "a:b:c",
					revertedAt: T0 + 10,
				}),
			),
			insertChangeLogEntry(
				db,
				entry({
					occurredAt: T0 + 1,
					action: "category_created",
					targetType: "category",
					targetId: "cat-1",
				}),
			),
		]);

		const sql =
			"SELECT * FROM change_log ORDER BY occurred_at DESC, id DESC LIMIT 10";
		const { results } = await db.prepare(sql).all<ChangeLogRow>();
		const entries = results.map(changeLogEntryFromRow);
		expect(entries).toHaveLength(3);
		expect(entries[0]?.action).toBe("category_created");
		expect(entries[1]?.actorType).toBe("admin_bot");
		expect(entries[1]?.approverId).toBe("me");
		expect(entries[1]?.revertedAt).toBe(T0 + 10);
		expect(entries[2]?.id).toBe(first.meta.last_row_id);
		expect(await queryPlan(sql)).toContain("change_log_occurred_at_idx");
	});

	it("uses the target index when querying by target_type and target_id", async () => {
		await insertChangeLogEntry(db, entry({ targetId: "agent-a" })).run();
		const sql =
			"SELECT * FROM change_log WHERE target_type = ? AND target_id = ? ORDER BY id DESC";
		const { results } = await db
			.prepare(sql)
			.bind("agent", "agent-a")
			.all<ChangeLogRow>();
		expect(results).toHaveLength(1);
		expect(await queryPlan(sql, "agent", "agent-a")).toContain(
			"change_log_target_idx",
		);
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
	it("removes a rejection without a category when its question's category is deleted", async () => {
		const asked = question(a, b, categoryId, { status: "expired" });
		const rejection = reply(asked, {
			kind: "rejection",
			fromAgentId: null,
			categoryId: null,
			body: null,
		});
		await db.batch([asked, rejection].map((m) => insertMessage(db, m)));

		await db
			.prepare("DELETE FROM categories WHERE id = ?")
			.bind(categoryId)
			.run();

		expect(await messageCount()).toBe(0);
	});
});

describe("migrations", () => {
	const migration = migrationByName;

	it("preserves all existing tables when migrating a populated database from 0002 to 0003 and enforces change_log constraints", async () => {
		await db.batch([
			db.prepare("DROP TABLE IF EXISTS proposals"),
			db.prepare("DROP TABLE IF EXISTS admin_bot_config"),
			db.prepare("DROP TABLE IF EXISTS change_log"),
			db.prepare("DROP TABLE IF EXISTS audit_log"),
			db.prepare("DROP TABLE IF EXISTS messages"),
			db.prepare("DROP TABLE IF EXISTS allow_rules"),
			db.prepare("DROP TABLE IF EXISTS tokens"),
			db.prepare("DROP TABLE IF EXISTS categories"),
			db.prepare("DROP TABLE IF EXISTS agents"),
			db.prepare("DROP TABLE IF EXISTS d1_migrations"),
		]);

		const m1 = migration("0001_initial_schema.sql");
		const m2 = migration("0002_cascade_message_references.sql");
		const m3 = migration("0003_change_log.sql");
		await applyD1Migrations(db, [m1, m2]);

		const a = await seedAgent(db, { name: "a" });
		const b = await seedAgent(db, { name: "b" });
		const category = await seedCategory(db, { name: "schedule" });
		const rule: AllowRule = {
			fromAgentId: a.id,
			toAgentId: b.id,
			categoryId: category.id,
			createdAt: T0,
		};
		const tok: Token = {
			id: newId(),
			agentId: a.id,
			tokenHash: `hash-${newId()}`,
			purpose: "participant",
			createdAt: T0,
			revokedAt: null,
		};
		const msg = question(a, b, category.id);
		const audit: NewAuditLogEntry = {
			occurredAt: T0,
			eventType: "question_accepted",
			fromAgentId: a.id,
			toAgentId: b.id,
			categoryId: category.id,
			outcome: "ok",
			reasonCode: null,
			messageId: msg.id,
			body: null,
		};
		await db.batch([
			insertAllowRule(db, rule),
			insertToken(db, tok),
			insertMessage(db, msg),
			insertAuditLogEntry(db, audit),
		]);

		await applyD1Migrations(db, [m1, m2, m3]);

		const fkViolations = await db.prepare("PRAGMA foreign_key_check").all();
		expect(fkViolations.results).toEqual([]);

		expect(
			(
				await db.prepare("SELECT * FROM agents ORDER BY name").all<AgentRow>()
			).results.map(agentFromRow),
		).toEqual([a, b]);
		expect(
			(
				await db.prepare("SELECT * FROM categories").all<CategoryRow>()
			).results.map(categoryFromRow),
		).toEqual([category]);
		expect(
			(
				await db.prepare("SELECT * FROM allow_rules").all<AllowRuleRow>()
			).results.map(allowRuleFromRow),
		).toEqual([rule]);
		expect(
			(await db.prepare("SELECT * FROM tokens").all<TokenRow>()).results.map(
				tokenFromRow,
			),
		).toEqual([tok]);
		expect(
			(
				await db.prepare("SELECT * FROM messages").all<MessageRow>()
			).results.map(messageFromRow),
		).toEqual([msg]);
		const auditRows = (
			await db.prepare("SELECT * FROM audit_log").all<AuditLogRow>()
		).results.map(auditLogEntryFromRow);
		expect(auditRows.map(({ id: _id, ...rest }) => rest)).toEqual([audit]);

		for (const actorType of ["owner", "admin_bot"] as const) {
			for (const targetType of [
				"agent",
				"token",
				"category",
				"allow_rule",
				"admin_bot",
				"description",
			] as const) {
				await db
					.prepare(
						`INSERT INTO change_log
							(occurred_at, actor_type, actor_id, action, target_type, target_id)
						VALUES (?, ?, 'actor-1', 'test_action', ?, 'target-1')`,
					)
					.bind(T0, actorType, targetType)
					.run();
			}
		}

		await expect(
			db
				.prepare(
					`INSERT INTO change_log
						(occurred_at, actor_type, actor_id, action, target_type, target_id)
					VALUES (?, 'agent', 'actor-1', 'test_action', 'agent', 'target-1')`,
				)
				.bind(T0)
				.run(),
		).rejects.toThrow(/CHECK/);

		await expect(
			db
				.prepare(
					`INSERT INTO change_log
						(occurred_at, actor_type, actor_id, action, target_type, target_id)
					VALUES (?, 'owner', 'actor-1', 'test_action', 'message', 'target-1')`,
				)
				.bind(T0)
				.run(),
		).rejects.toThrow(/CHECK/);

		await expect(
			db
				.prepare(
					`INSERT INTO change_log
						(occurred_at, actor_type, actor_id, action, target_type, target_id)
					VALUES ('not-an-int', 'owner', 'actor-1', 'test_action', 'agent', 'target-1')`,
				)
				.run(),
		).rejects.toThrow(/STRICT|datatype/i);

		await expect(
			db
				.prepare(
					`INSERT INTO change_log
						(occurred_at, actor_type, actor_id, action, target_type, target_id)
					VALUES (?, 'owner', NULL, 'test_action', 'agent', 'target-1')`,
				)
				.bind(T0)
				.run(),
		).rejects.toThrow(/NOT NULL/);
	});

	it("preserves all existing tables when migrating a populated database from 0003 to 0004 and enforces admin_bot_config constraints", async () => {
		await db.batch([
			db.prepare("DROP TABLE IF EXISTS proposals"),
			db.prepare("DROP TABLE IF EXISTS admin_bot_config"),
			db.prepare("DROP TABLE IF EXISTS change_log"),
			db.prepare("DROP TABLE IF EXISTS audit_log"),
			db.prepare("DROP TABLE IF EXISTS messages"),
			db.prepare("DROP TABLE IF EXISTS allow_rules"),
			db.prepare("DROP TABLE IF EXISTS tokens"),
			db.prepare("DROP TABLE IF EXISTS categories"),
			db.prepare("DROP TABLE IF EXISTS agents"),
			db.prepare("DROP TABLE IF EXISTS d1_migrations"),
		]);

		const m1 = migration("0001_initial_schema.sql");
		const m2 = migration("0002_cascade_message_references.sql");
		const m3 = migration("0003_change_log.sql");
		const m4 = migration("0004_admin_bot.sql");
		await applyD1Migrations(db, [m1, m2, m3]);

		const a = await seedAgent(db, { name: "a" });
		const b = await seedAgent(db, { name: "b" });
		const category = await seedCategory(db, { name: "schedule" });
		const rule: AllowRule = {
			fromAgentId: a.id,
			toAgentId: b.id,
			categoryId: category.id,
			createdAt: T0,
		};
		const tok: Token = {
			id: newId(),
			agentId: a.id,
			tokenHash: `hash-${newId()}`,
			purpose: "participant",
			createdAt: T0,
			revokedAt: null,
		};
		const msg = question(a, b, category.id);
		const audit: NewAuditLogEntry = {
			occurredAt: T0,
			eventType: "question_accepted",
			fromAgentId: a.id,
			toAgentId: b.id,
			categoryId: category.id,
			outcome: "ok",
			reasonCode: null,
			messageId: msg.id,
			body: null,
		};
		const change: NewChangeLogEntry = {
			occurredAt: T0,
			actorType: "owner",
			actorId: "me",
			approverId: null,
			action: "agent_registered",
			targetType: "agent",
			targetId: a.id,
			beforeJson: null,
			afterJson: JSON.stringify(a),
			revertedAt: null,
		};
		await db.batch([
			insertAllowRule(db, rule),
			insertToken(db, tok),
			insertMessage(db, msg),
			insertAuditLogEntry(db, audit),
			insertChangeLogEntry(db, change),
		]);

		await applyD1Migrations(db, [m1, m2, m3, m4]);

		const fkViolations = await db.prepare("PRAGMA foreign_key_check").all();
		expect(fkViolations.results).toEqual([]);

		expect(
			(
				await db.prepare("SELECT * FROM agents ORDER BY name").all<AgentRow>()
			).results.map(agentFromRow),
		).toEqual([a, b]);
		expect(
			(
				await db.prepare("SELECT * FROM categories").all<CategoryRow>()
			).results.map(categoryFromRow),
		).toEqual([category]);
		expect(
			(
				await db.prepare("SELECT * FROM allow_rules").all<AllowRuleRow>()
			).results.map(allowRuleFromRow),
		).toEqual([rule]);
		expect(
			(await db.prepare("SELECT * FROM tokens").all<TokenRow>()).results.map(
				tokenFromRow,
			),
		).toEqual([tok]);
		expect(
			(
				await db.prepare("SELECT * FROM messages").all<MessageRow>()
			).results.map(messageFromRow),
		).toEqual([msg]);
		const auditRows = (
			await db.prepare("SELECT * FROM audit_log").all<AuditLogRow>()
		).results.map(auditLogEntryFromRow);
		expect(auditRows.map(({ id: _id, ...rest }) => rest)).toEqual([audit]);
		const changeRows = (
			await db.prepare("SELECT * FROM change_log").all<ChangeLogRow>()
		).results.map(changeLogEntryFromRow);
		expect(changeRows.map(({ id: _id, ...rest }) => rest)).toEqual([change]);

		await db
			.prepare(
				`INSERT INTO admin_bot_config (id, agent_id, read_bodies, superadmin_until, updated_at)
				VALUES (1, ?, 1, ?, ?)`,
			)
			.bind(a.id, T0 + 1000, T0 + 10)
			.run();
		const configRow = await db
			.prepare("SELECT * FROM admin_bot_config WHERE id = 1")
			.first<AdminBotConfigRow>();
		expect(configRow && adminBotConfigFromRow(configRow)).toEqual({
			agentId: a.id,
			readBodies: true,
			superadminUntil: T0 + 1000,
			updatedAt: T0 + 10,
		});

		await db.prepare("DELETE FROM agents WHERE id = ?").bind(a.id).run();
		const afterAgentDelete = await db
			.prepare("SELECT * FROM admin_bot_config WHERE id = 1")
			.first<AdminBotConfigRow>();
		expect(afterAgentDelete?.agent_id).toBeNull();
		expect(afterAgentDelete && adminBotConfigFromRow(afterAgentDelete)).toEqual(
			{
				agentId: null,
				readBodies: false,
				superadminUntil: null,
				updatedAt: T0 + 10,
			},
		);

		await expect(
			db
				.prepare(
					`INSERT INTO admin_bot_config (id, agent_id, read_bodies, superadmin_until, updated_at)
					VALUES (2, NULL, 0, NULL, ?)`,
				)
				.bind(T0)
				.run(),
		).rejects.toThrow(/CHECK/);

		await expect(
			db
				.prepare(`UPDATE admin_bot_config SET read_bodies = 2 WHERE id = 1`)
				.run(),
		).rejects.toThrow(/CHECK/);

		await expect(
			db
				.prepare(
					`UPDATE admin_bot_config SET updated_at = 'bad-int' WHERE id = 1`,
				)
				.run(),
		).rejects.toThrow(/STRICT|datatype/i);

		await expect(
			db
				.prepare(`UPDATE admin_bot_config SET agent_id = ? WHERE id = 1`)
				.bind(newId())
				.run(),
		).rejects.toThrow(/FOREIGN KEY/);
	});

	it("preserves all existing tables when migrating a populated database from 0004 to 0005 and enforces proposals constraints", async () => {
		await db.batch([
			db.prepare("DROP TABLE IF EXISTS proposals"),
			db.prepare("DROP TABLE IF EXISTS admin_bot_config"),
			db.prepare("DROP TABLE IF EXISTS change_log"),
			db.prepare("DROP TABLE IF EXISTS audit_log"),
			db.prepare("DROP TABLE IF EXISTS messages"),
			db.prepare("DROP TABLE IF EXISTS allow_rules"),
			db.prepare("DROP TABLE IF EXISTS tokens"),
			db.prepare("DROP TABLE IF EXISTS categories"),
			db.prepare("DROP TABLE IF EXISTS agents"),
			db.prepare("DROP TABLE IF EXISTS d1_migrations"),
		]);

		const m1 = migration("0001_initial_schema.sql");
		const m2 = migration("0002_cascade_message_references.sql");
		const m3 = migration("0003_change_log.sql");
		const m4 = migration("0004_admin_bot.sql");
		const m5 = migration("0005_proposals.sql");
		await applyD1Migrations(db, [m1, m2, m3, m4]);

		const a = await seedAgent(db, { name: "a" });
		const b = await seedAgent(db, { name: "b" });
		const category = await seedCategory(db, { name: "schedule" });
		await db
			.prepare(
				`INSERT INTO admin_bot_config (id, agent_id, read_bodies, superadmin_until, updated_at)
				VALUES (1, ?, 0, NULL, ?)`,
			)
			.bind(a.id, T0)
			.run();

		await applyD1Migrations(db, [m1, m2, m3, m4, m5]);

		const fkViolations = await db.prepare("PRAGMA foreign_key_check").all();
		expect(fkViolations.results).toEqual([]);

		expect(
			(
				await db.prepare("SELECT * FROM agents ORDER BY name").all<AgentRow>()
			).results.map(agentFromRow),
		).toEqual([a, b]);
		const configRow = await db
			.prepare("SELECT * FROM admin_bot_config WHERE id = 1")
			.first<AdminBotConfigRow>();
		expect(configRow?.agent_id).toBe(a.id);

		const proposal: Proposal = {
			id: newId(),
			kind: "grant_allow_rule",
			proposerAgentId: a.id,
			payload: {
				kind: "grant_allow_rule",
				fromAgentId: a.id,
				toAgentId: b.id,
				categoryId: category.id,
			},
			reason: "Allow schedule lookup",
			status: "pending",
			createdAt: T0,
			expiresAt: T0 + 14 * DAY_MS,
			resolvedAt: null,
			resolvedBy: null,
			changeLogId: null,
		};
		await insertProposal(db, proposal).run();

		const loaded = await db
			.prepare("SELECT * FROM proposals WHERE id = ?")
			.bind(proposal.id)
			.first<ProposalRow>();
		expect(loaded && proposalFromRow(loaded)).toEqual(proposal);

		await expect(
			db
				.prepare(
					`INSERT INTO proposals
						(id, kind, proposer_agent_id, payload_json, reason, status, created_at, expires_at, resolved_at)
					VALUES (?, 'unknown_kind', ?, '{}', 'r', 'pending', ?, ?, NULL)`,
				)
				.bind(newId(), a.id, T0, T0 + 14 * DAY_MS)
				.run(),
		).rejects.toThrow(/CHECK/);

		await expect(
			db
				.prepare(
					`INSERT INTO proposals
						(id, kind, proposer_agent_id, payload_json, reason, status, created_at, expires_at, resolved_at)
					VALUES (?, 'create_category', ?, '{"kind":"create_category","name":"x"}', 'r', 'cancelled', ?, ?, ?)`,
				)
				.bind(newId(), a.id, T0, T0 + 14 * DAY_MS, T0 + 1)
				.run(),
		).rejects.toThrow(/CHECK/);

		// Pending row with non-null resolved_at violates CHECK.
		await expect(
			insertProposal(db, {
				...proposal,
				id: newId(),
				status: "pending",
				resolvedAt: T0 + 1,
			}).run(),
		).rejects.toThrow(/CHECK/);

		// Resolved row with null resolved_at violates CHECK.
		for (const status of ["approved", "rejected", "expired"] as const) {
			await expect(
				insertProposal(db, {
					...proposal,
					id: newId(),
					status,
					resolvedAt: null,
				}).run(),
			).rejects.toThrow(/CHECK/);
		}

		// STRICT type check on created_at.
		await expect(
			db
				.prepare(
					`INSERT INTO proposals
						(id, kind, proposer_agent_id, payload_json, reason, status, created_at, expires_at, resolved_at)
					VALUES (?, 'create_category', ?, '{"kind":"create_category","name":"x"}', 'r', 'pending', 'not-int', ?, NULL)`,
				)
				.bind(newId(), a.id, T0 + 14 * DAY_MS)
				.run(),
		).rejects.toThrow(/STRICT|datatype/i);

		// Foreign key on proposer_agent_id and ON DELETE CASCADE.
		await expect(
			insertProposal(db, {
				...proposal,
				id: newId(),
				proposerAgentId: newId(),
			}).run(),
		).rejects.toThrow(/FOREIGN KEY/);

		await db.prepare("DELETE FROM agents WHERE id = ?").bind(a.id).run();
		const remaining = await db
			.prepare("SELECT COUNT(*) AS n FROM proposals")
			.first<{ n: number }>();
		expect(remaining?.n).toBe(0);
	});
});

describe("proposals", () => {
	it("stores all payload variants and uses status and expiry indexes", async () => {
		const bot = await seedAgent(db, { name: "bot" });
		const target = await seedAgent(db, { name: "target" });
		const cat = await seedCategory(db, { name: "work" });

		const entries: Proposal[] = [
			{
				id: newId(),
				kind: "grant_allow_rule",
				proposerAgentId: bot.id,
				payload: {
					kind: "grant_allow_rule",
					fromAgentId: bot.id,
					toAgentId: target.id,
					categoryId: cat.id,
				},
				reason: "Allow work",
				status: "pending",
				createdAt: T0,
				expiresAt: T0 + 14 * DAY_MS,
				resolvedAt: null,
				resolvedBy: null,
				changeLogId: null,
			},
			{
				id: newId(),
				kind: "create_category",
				proposerAgentId: bot.id,
				payload: { kind: "create_category", name: "travel" },
				reason: "Add travel",
				status: "approved",
				createdAt: T0 + 1,
				expiresAt: T0 + 14 * DAY_MS + 1,
				resolvedAt: T0 + 10,
				resolvedBy: "owner@example.com",
				changeLogId: 42,
			},
			{
				id: newId(),
				kind: "raise_daily_limit",
				proposerAgentId: bot.id,
				payload: {
					kind: "raise_daily_limit",
					agentId: target.id,
					newLimit: 50,
				},
				reason: "Higher traffic",
				status: "rejected",
				createdAt: T0 + 2,
				expiresAt: T0 + 14 * DAY_MS + 2,
				resolvedAt: T0 + 20,
				resolvedBy: "owner@example.com",
				changeLogId: null,
			},
			{
				id: newId(),
				kind: "resume_agent",
				proposerAgentId: bot.id,
				payload: { kind: "resume_agent", agentId: target.id },
				reason: "Issue resolved",
				status: "expired",
				createdAt: T0 + 3,
				expiresAt: T0 + 14 * DAY_MS + 3,
				resolvedAt: T0 + 14 * DAY_MS + 3,
				resolvedBy: null,
				changeLogId: null,
			},
		];

		await db.batch(entries.map((entry) => insertProposal(db, entry)));

		const { results } = await db
			.prepare("SELECT * FROM proposals ORDER BY created_at ASC")
			.all<ProposalRow>();
		expect(results.map(proposalFromRow)).toEqual(entries);

		const { results: indexes } = await db
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'proposals' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all<{ name: string }>();
		expect(indexes.map((row) => row.name)).toEqual([
			"proposals_expiry_idx",
			"proposals_status_idx",
		]);
		expect(
			await queryPlan(
				"SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC",
				"pending",
			),
		).toContain("proposals_status_idx");
		expect(
			await queryPlan(
				"SELECT id FROM proposals INDEXED BY proposals_expiry_idx WHERE status = 'pending' AND expires_at <= ?",
				T0 + 14 * DAY_MS,
			),
		).toContain("proposals_expiry_idx");
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

	it("throws on unknown change_log enum values", async () => {
		await db
			.prepare(
				`INSERT INTO change_log
					(occurred_at, actor_type, actor_id, action, target_type, target_id)
				VALUES (?, 'owner', 'me', 'unknown_action', 'agent', 'a1')`,
			)
			.bind(T0)
			.run();
		const row = await db
			.prepare("SELECT * FROM change_log")
			.first<ChangeLogRow>();
		expect(() => changeLogEntryFromRow(row as ChangeLogRow)).toThrow(
			/change_log\.action/,
		);
	});

	it("throws on invalid admin_bot_config.read_bodies value", () => {
		expect(() =>
			adminBotConfigFromRow({
				id: 1,
				agent_id: "a1",
				read_bodies: 2,
				superadmin_until: null,
				updated_at: T0,
			}),
		).toThrow(/admin_bot_config\.read_bodies/);
	});

	it("validates proposal kind, status, and payload_json strictly", () => {
		const validRow: ProposalRow = {
			id: "p1",
			kind: "create_category",
			proposer_agent_id: "a1",
			payload_json: JSON.stringify({ kind: "create_category", name: "travel" }),
			reason: "Need travel",
			status: "pending",
			created_at: T0,
			expires_at: T0 + 14 * DAY_MS,
			resolved_at: null,
			resolved_by: null,
			change_log_id: null,
		};
		expect(proposalFromRow(validRow).payload).toEqual({
			kind: "create_category",
			name: "travel",
		});

		expect(() => proposalFromRow({ ...validRow, kind: "bogus" })).toThrow(
			/proposals\.kind/,
		);
		expect(() => proposalFromRow({ ...validRow, status: "bogus" })).toThrow(
			/proposals\.status/,
		);
		expect(() => parseProposalPayload("create_category", "{bad json")).toThrow(
			/Invalid JSON/,
		);
		expect(() =>
			parseProposalPayload(
				"create_category",
				JSON.stringify({ kind: "resume_agent", agentId: "a1" }),
			),
		).toThrow(/Mismatched kind/);
		expect(() =>
			parseProposalPayload(
				"grant_allow_rule",
				JSON.stringify({
					kind: "grant_allow_rule",
					fromAgentId: "a1",
					toAgentId: "",
					categoryId: "c1",
				}),
			),
		).toThrow(/toAgentId/);
		expect(() =>
			parseProposalPayload(
				"raise_daily_limit",
				JSON.stringify({
					kind: "raise_daily_limit",
					agentId: "a1",
					newLimit: -1,
				}),
			),
		).toThrow(/newLimit/);
	});
});

describe("migration 0002 on populated data", () => {
	it("preserves existing answers and rejections when upgrading from 0001", async () => {
		const m0001 = migrationByName("0001_initial_schema.sql");
		const m0002 = migrationByName("0002_cascade_message_references.sql");

		for (const table of [
			"proposals",
			"admin_bot_config",
			"change_log",
			"audit_log",
			"messages",
			"allow_rules",
			"tokens",
			"categories",
			"agents",
			"d1_migrations",
		]) {
			await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
		}

		await applyD1Migrations(db, [m0001]);

		const a = await seedAgent(db, { name: "a" });
		const b = await seedAgent(db, { name: "b" });
		const cat = await seedCategory(db, { name: "schedule" });
		const q1 = question(a, b, cat.id, { status: "answered" });
		const r1 = reply(q1, { body: "confirmed" });
		const q2 = question(b, a, cat.id, { status: "declined" });
		const r2 = reply(q2, {
			kind: "rejection",
			fromAgentId: null,
			body: null,
		});
		await db.batch([q1, r1, q2, r2].map((m) => insertMessage(db, m)));

		await applyD1Migrations(db, [m0001, m0002]);

		const { results } = await db
			.prepare("SELECT id, kind, in_reply_to, body FROM messages ORDER BY id")
			.all<{
				id: string;
				kind: string;
				in_reply_to: string | null;
				body: string | null;
			}>();
		expect(results.map((r) => r.id).sort()).toEqual(
			[q1.id, r1.id, q2.id, r2.id].sort(),
		);
		expect(results.find((r) => r.id === r1.id)).toMatchObject({
			kind: "answer",
			in_reply_to: q1.id,
			body: "confirmed",
		});
		expect(results.find((r) => r.id === r2.id)).toMatchObject({
			kind: "rejection",
			in_reply_to: q2.id,
			body: null,
		});
		const fkCheck = await db.prepare("PRAGMA foreign_key_check").all();
		expect(fkCheck.results).toEqual([]);

		await db.prepare("DELETE FROM agents WHERE id = ?").bind(a.id).run();
		const remaining = await db
			.prepare("SELECT COUNT(*) AS n FROM messages")
			.first<{ n: number }>();
		expect(remaining?.n).toBe(0);
	});
});
