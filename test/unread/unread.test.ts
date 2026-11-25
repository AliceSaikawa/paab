import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { queryAuditLog } from "../../src/audit";
import { issueToken } from "../../src/auth";
import { insertMessage, newId } from "../../src/db";
import { fetchInbox, submitQuestion } from "../../src/inbox";
import { handleUnreadRequest } from "../../src/unread";
import { createTestDb } from "../helpers/db";
import {
	DAY_MS,
	HOUR_MS,
	seedAgent,
	seedCategory,
	T0,
} from "../helpers/fixtures";

const UNREAD_URL = "http://example.com/unread";

let db: D1Database;

beforeEach(async () => {
	db = await createTestDb();
});

function unreadRequest(authorization: string | null, method = "GET"): Request {
	const headers = new Headers();
	if (authorization !== null) {
		headers.set("Authorization", authorization);
	}
	return new Request(UNREAD_URL, { method, headers });
}

async function authFailureLogs() {
	return (await queryAuditLog(db))
		.filter((entry) => entry.eventType === "auth_failed")
		.map((entry) => ({
			fromAgentId: entry.fromAgentId,
			reasonCode: entry.reasonCode,
			outcome: entry.outcome,
		}));
}

describe("GET /unread", () => {
	it("routes /unread through the worker outside Access and rejects non-GET with 405", async () => {
		const alice = await seedAgent(db, { name: "alice" });
		const bob = await seedAgent(db, { name: "bob" });
		const schedule = await seedCategory(db, { name: "schedule" });
		const { token } = await issueToken(db, {
			agentId: bob.id,
			purpose: "unread_count",
			now: T0,
		});

		const wallNow = Date.now();
		await insertMessage(db, {
			id: newId(),
			kind: "question",
			fromAgentId: alice.id,
			toAgentId: bob.id,
			categoryId: schedule.id,
			body: "secret body",
			inReplyTo: null,
			status: "pending",
			createdAt: wallNow - 1000,
			receivedAt: null,
			expiresAt: wallNow + DAY_MS,
			bodyDeletedAt: null,
		}).run();

		const unauth = await SELF.fetch(unreadRequest(null));
		expect(unauth.status).toBe(401);
		expect(unauth.headers.get("WWW-Authenticate")).toBe("Bearer");

		for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
			const methodRes = await SELF.fetch(
				unreadRequest(`Bearer ${token}`, method),
			);
			expect(methodRes.status).toBe(405);
			expect(methodRes.headers.get("Allow")).toBe("GET");
		}

		const okRes = await SELF.fetch(unreadRequest(`Bearer ${token}`));
		expect(okRes.status).toBe(200);
		expect(okRes.headers.get("Content-Type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(okRes.headers.get("Cache-Control")).toBe("no-store");
		const json = await okRes.json();
		expect(json).toEqual({ unread: 1 });
	});

	it("returns 405 with Allow: GET for non-GET requests without writing auth_failed", async () => {
		for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
			const response = await handleUnreadRequest(
				unreadRequest(null, method),
				env,
				T0,
			);
			expect(response.status).toBe(405);
			expect(response.headers.get("Allow")).toBe("GET");
		}
		expect(await authFailureLogs()).toEqual([]);
	});

	it("rejects missing, malformed, unknown, revoked, and wrong-purpose tokens identically with 401", async () => {
		const alice = await seedAgent(db, { name: "alice" });
		const participant = await issueToken(db, {
			agentId: alice.id,
			purpose: "participant",
			now: T0,
		});
		const admin = await issueToken(db, {
			agentId: alice.id,
			purpose: "admin",
			now: T0 + 1,
		});
		const unread1 = await issueToken(db, {
			agentId: alice.id,
			purpose: "unread_count",
			now: T0 + 2,
		});
		await issueToken(db, {
			agentId: alice.id,
			purpose: "unread_count",
			now: T0 + 3,
		});

		const cases = [
			{
				header: null,
				expectedAgentId: null,
				expectedReason: "token_missing",
			},
			{
				header: "",
				expectedAgentId: null,
				expectedReason: "token_missing",
			},
			{
				header: `Basic ${unread1.token}`,
				expectedAgentId: null,
				expectedReason: "token_missing",
			},
			{
				header: `Bearer paab_${"A".repeat(43)}`,
				expectedAgentId: null,
				expectedReason: "token_unknown",
			},
			{
				header: "Bearer not-a-token",
				expectedAgentId: null,
				expectedReason: "token_unknown",
			},
			{
				header: `Bearer ${unread1.token}`,
				expectedAgentId: alice.id,
				expectedReason: "token_revoked",
			},
			{
				header: `Bearer ${participant.token}`,
				expectedAgentId: alice.id,
				expectedReason: "token_unknown",
			},
			{
				header: `Bearer ${admin.token}`,
				expectedAgentId: alice.id,
				expectedReason: "token_unknown",
			},
		] as const;

		for (const [index, testCase] of cases.entries()) {
			const res = await handleUnreadRequest(
				unreadRequest(testCase.header),
				env,
				T0 + 10 + index,
			);
			expect(res.status).toBe(401);
			expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
			expect(await res.text()).toBe("");
		}

		const logs = await authFailureLogs();
		expect(logs).toEqual(
			cases.map((c) => ({
				fromAgentId: c.expectedAgentId,
				reasonCode: c.expectedReason,
				outcome: "denied",
			})),
		);
	});

	it("returns 403 and logs sender_suspended for a suspended agent, then allows after resume", async () => {
		const agent = await seedAgent(db, { name: "muse", status: "suspended" });
		const { token } = await issueToken(db, {
			agentId: agent.id,
			purpose: "unread_count",
			now: T0,
		});

		const denied = await handleUnreadRequest(
			unreadRequest(`Bearer ${token}`),
			env,
			T0 + 1,
		);
		expect(denied.status).toBe(403);
		expect(await denied.text()).toBe("agent suspended");
		expect(await authFailureLogs()).toEqual([
			{
				fromAgentId: agent.id,
				reasonCode: "sender_suspended",
				outcome: "denied",
			},
		]);

		await db
			.prepare("UPDATE agents SET status = 'active' WHERE id = ?")
			.bind(agent.id)
			.run();
		const allowed = await handleUnreadRequest(
			unreadRequest(`Bearer ${token}`),
			env,
			T0 + 2,
		);
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toEqual({ unread: 0 });
	});

	it("counts deliverable non-expired messages accurately without touching received_at or leaking message fields", async () => {
		const alice = await seedAgent(db, { name: "alice" });
		const bob = await seedAgent(db, { name: "bob" });
		const schedule = await seedCategory(db, { name: "schedule" });

		const bobUnreadToken = await issueToken(db, {
			agentId: bob.id,
			purpose: "unread_count",
			now: T0,
		});
		const aliceUnreadToken = await issueToken(db, {
			agentId: alice.id,
			purpose: "unread_count",
			now: T0,
		});

		const q1 = await submitQuestion(db, {
			fromAgentId: alice.id,
			toAgentId: bob.id,
			categoryId: schedule.id,
			body: "confidential question 1",
			now: T0,
		});
		const qExpiredBeforeMaintenance = await submitQuestion(db, {
			fromAgentId: alice.id,
			toAgentId: bob.id,
			categoryId: schedule.id,
			body: "expired question",
			now: T0 - 7 * DAY_MS,
		});
		const qForAnswer = newId();
		const qForRejection = newId();
		await db.batch([
			insertMessage(db, {
				id: qForAnswer,
				kind: "question",
				fromAgentId: bob.id,
				toAgentId: alice.id,
				categoryId: schedule.id,
				body: "question already received and answered",
				inReplyTo: null,
				status: "answered",
				createdAt: T0,
				receivedAt: T0 + 10,
				expiresAt: T0 + 7 * DAY_MS,
				bodyDeletedAt: null,
			}),
			insertMessage(db, {
				id: qForRejection,
				kind: "question",
				fromAgentId: alice.id,
				toAgentId: bob.id,
				categoryId: schedule.id,
				body: "question already received and declined",
				inReplyTo: null,
				status: "declined",
				createdAt: T0,
				receivedAt: T0 + 10,
				expiresAt: T0 + 7 * DAY_MS,
				bodyDeletedAt: null,
			}),
			insertMessage(db, {
				id: newId(),
				kind: "question",
				fromAgentId: alice.id,
				toAgentId: bob.id,
				categoryId: schedule.id,
				body: "already delivered",
				inReplyTo: null,
				status: "pending",
				createdAt: T0,
				receivedAt: T0 + 100,
				expiresAt: T0 + 7 * DAY_MS,
				bodyDeletedAt: null,
			}),
			insertMessage(db, {
				id: newId(),
				kind: "question",
				fromAgentId: alice.id,
				toAgentId: bob.id,
				categoryId: schedule.id,
				body: "blocked question",
				inReplyTo: null,
				status: "blocked",
				createdAt: T0,
				receivedAt: null,
				expiresAt: null,
				bodyDeletedAt: null,
			}),
			insertMessage(db, {
				id: newId(),
				kind: "answer",
				fromAgentId: alice.id,
				toAgentId: bob.id,
				categoryId: schedule.id,
				body: "unread answer",
				inReplyTo: qForAnswer,
				status: "sent",
				createdAt: T0 + HOUR_MS,
				receivedAt: null,
				expiresAt: null,
				bodyDeletedAt: null,
			}),
			insertMessage(db, {
				id: newId(),
				kind: "rejection",
				fromAgentId: bob.id,
				toAgentId: alice.id,
				categoryId: schedule.id,
				body: null,
				inReplyTo: qForRejection,
				status: "sent",
				createdAt: T0 + HOUR_MS,
				receivedAt: null,
				expiresAt: null,
				bodyDeletedAt: null,
			}),
		]);

		const queryTime = T0 + 2 * HOUR_MS;
		// qExpiredBeforeMaintenance expired at T0, so queryTime > T0 excludes it even before sweep.
		expect(qExpiredBeforeMaintenance.expiresAt).toBe(T0);

		const bobFirst = await handleUnreadRequest(
			unreadRequest(`Bearer ${bobUnreadToken.token}`),
			env,
			queryTime,
		);
		expect(bobFirst.status).toBe(200);
		expect(bobFirst.headers.get("Content-Type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(bobFirst.headers.get("Cache-Control")).toBe("no-store");
		const bobRaw = await bobFirst.text();
		expect(bobRaw).toBe('{"unread":2}');
		expect(bobRaw).not.toContain("confidential");
		expect(bobRaw).not.toContain(q1.questionId);
		expect(bobRaw).not.toContain(alice.id);
		expect(bobRaw).not.toContain(schedule.id);

		// Calling /unread again keeps returning 2 and never marks received_at.
		const bobSecond = await handleUnreadRequest(
			unreadRequest(`Bearer ${bobUnreadToken.token}`),
			env,
			queryTime + 1000,
		);
		expect(await bobSecond.json()).toEqual({ unread: 2 });

		const q1Row = await db
			.prepare("SELECT received_at FROM messages WHERE id = ?")
			.bind(q1.questionId)
			.first<{ received_at: number | null }>();
		expect(q1Row?.received_at).toBeNull();

		// Alice only sees her own 1 unread rejection.
		const aliceRes = await handleUnreadRequest(
			unreadRequest(`Bearer ${aliceUnreadToken.token}`),
			env,
			queryTime,
		);
		expect(await aliceRes.json()).toEqual({ unread: 1 });

		// Successful /unread polling leaves audit_log untouched.
		expect(await queryAuditLog(db)).toEqual([]);

		// Fetching Bob's inbox delivers those 2 items and drops unread count to 0.
		const delivered = await fetchInbox(db, bob.id, queryTime + 2000);
		expect(delivered).toHaveLength(2);
		const bobAfterFetch = await handleUnreadRequest(
			unreadRequest(`Bearer ${bobUnreadToken.token}`),
			env,
			queryTime + 3000,
		);
		expect(await bobAfterFetch.json()).toEqual({ unread: 0 });
	});

	it("excludes a question right at its expiresAt boundary", async () => {
		const alice = await seedAgent(db, { name: "alice" });
		const bob = await seedAgent(db, { name: "bob" });
		const schedule = await seedCategory(db, { name: "schedule" });
		const { token } = await issueToken(db, {
			agentId: bob.id,
			purpose: "unread_count",
			now: T0,
		});

		const q = await submitQuestion(db, {
			fromAgentId: alice.id,
			toAgentId: bob.id,
			categoryId: schedule.id,
			body: "expiring",
			now: T0,
		});

		const justBefore = await handleUnreadRequest(
			unreadRequest(`Bearer ${token}`),
			env,
			q.expiresAt - 1,
		);
		expect(await justBefore.json()).toEqual({ unread: 1 });

		const atExpiry = await handleUnreadRequest(
			unreadRequest(`Bearer ${token}`),
			env,
			q.expiresAt,
		);
		expect(await atExpiry.json()).toEqual({ unread: 0 });
	});
});
