import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	issueAgentToken,
	resumeAgent,
	revokeAgentTokens,
	suspendAgent,
} from "../../src/admin";
import { designateAdminBot, handleAdminMcpRequest } from "../../src/adminbot";
import { queryAuditLog } from "../../src/audit";
import { issueToken } from "../../src/auth";
import {
	answerQuestion,
	BRIDGE_REJECTION_DELAY_MS,
	fetchInbox,
	QUESTION_TTL_MS,
	recordBlockedQuestion,
	submitQuestion,
} from "../../src/inbox";
import { handleMcpRequest } from "../../src/mcp";
import type { Agent, Category } from "../../src/types";
import { handleUnreadRequest } from "../../src/unread";
import { createTestDb } from "../helpers/db";
import {
	DAY_MS,
	HOUR_MS,
	seedAgent,
	seedCategory,
	T0,
} from "../helpers/fixtures";
import {
	call,
	connect,
	MCP_URL,
	questionIdOf,
	unreadCount,
	withoutFooter,
} from "../mcp/support";

const UNREAD_URL = "https://paab.test/unread";
const ADMIN_MCP_URL = "https://paab.test/mcp/admin";
const OWNER: ChangeActor = { actorType: "owner", actorId: "owner@example.com" };

let db: D1Database;
let alice: Agent;
let bob: Agent;
let schedule: Category;
let aliceUnreadToken: string;
let aliceParticipantToken: string;
let aliceAdminToken: string;

function unreadGet(
	authorization: string | null,
	url = UNREAD_URL,
	now = T0,
): Promise<Response> {
	const headers = new Headers();
	if (authorization !== null) {
		headers.set("Authorization", authorization);
	}
	return handleUnreadRequest(
		new Request(url, { method: "GET", headers }),
		env,
		now,
	);
}

async function authFailedAudits() {
	const all = await queryAuditLog(db);
	return all.filter((entry) => entry.eventType === "auth_failed");
}

function mcpPostRequest(url: string, token: string): Request {
	return new Request(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test", version: "0.0.0" },
			},
		}),
	});
}

beforeEach(async () => {
	db = await createTestDb();
	alice = await seedAgent(db, { name: "alice" });
	bob = await seedAgent(db, { name: "bob" });
	schedule = await seedCategory(db, { name: "schedule" });

	await designateAdminBot(db, { agentId: alice.id, actor: OWNER, now: T0 });

	aliceUnreadToken = (
		await issueToken(db, {
			agentId: alice.id,
			purpose: "unread_count",
			now: T0,
		})
	).token;
	aliceParticipantToken = (
		await issueToken(db, {
			agentId: alice.id,
			purpose: "participant",
			now: T0,
		})
	).token;
	aliceAdminToken = (
		await issueToken(db, {
			agentId: alice.id,
			purpose: "admin",
			now: T0,
		})
	).token;
});

describe("GET /unread", () => {
	it("returns 200 with exact JSON shape, no-store header, and counts questions, answers, and rejections while excluding expired questions", async () => {
		const emptyRes = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			T0,
		);
		expect(emptyRes.status).toBe(200);
		expect(emptyRes.headers.get("Content-Type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(emptyRes.headers.get("Cache-Control")).toBe("no-store");
		const emptyText = await emptyRes.text();
		expect(emptyText).toBe('{"unread":0}');
		expect(Object.keys(JSON.parse(emptyText))).toEqual(["unread"]);

		// 1. Active pending question addressed to alice.
		const secretQuestionBody = "TOP_SECRET_QUESTION_BODY";
		const q1 = await submitQuestion(db, {
			fromAgentId: bob.id,
			toAgentId: alice.id,
			categoryId: schedule.id,
			body: secretQuestionBody,
			now: T0,
		});

		// 2. Expired pending question addressed to alice (past TTL before maintenance runs).
		await submitQuestion(db, {
			fromAgentId: bob.id,
			toAgentId: alice.id,
			categoryId: schedule.id,
			body: "EXPIRED_QUESTION_BODY",
			now: T0 - QUESTION_TTL_MS - 1,
		});

		// 3. Answer addressed to alice (alice asked bob, bob answered).
		const secretAnswerBody = "TOP_SECRET_ANSWER_BODY";
		const qFromAlice1 = await submitQuestion(db, {
			fromAgentId: alice.id,
			toAgentId: bob.id,
			categoryId: schedule.id,
			body: "Are you free?",
			now: T0,
		});
		const answerRes = await answerQuestion(db, {
			questionId: qFromAlice1.questionId,
			responderAgentId: bob.id,
			reply: { kind: "answer", body: secretAnswerBody },
			now: T0 + 1000,
		});
		expect(answerRes.ok).toBe(true);

		// 4. Rejection addressed to alice (from a blocked question at T0 + 2000).
		const blocked = await recordBlockedQuestion(db, {
			fromAgentId: alice.id,
			toAgentId: bob.id,
			categoryId: schedule.id,
			now: T0 + 2000,
		});

		// 5. Question addressed to bob (must NOT be counted for alice).
		await submitQuestion(db, {
			fromAgentId: alice.id,
			toAgentId: bob.id,
			categoryId: schedule.id,
			body: "For bob only",
			now: T0 + 3000,
		});

		// Before the 60s visibility delay elapses, only the active question and answer count.
		const beforeDelayRes = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			T0 + 4000,
		);
		expect(beforeDelayRes.status).toBe(200);
		expect(await beforeDelayRes.json()).toEqual({ unread: 2 });

		// Once the 60s visibility delay elapses, the blocked-question rejection is counted too.
		const res = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			T0 + 2000 + BRIDGE_REJECTION_DELAY_MS,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(res.headers.get("Cache-Control")).toBe("no-store");

		const rawBody = await res.text();
		const parsed = JSON.parse(rawBody) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual(["unread"]);
		expect(parsed).toEqual({ unread: 3 });

		// Ensure no message bodies, IDs, or agent identifiers leak into the response.
		expect(rawBody).not.toContain(secretQuestionBody);
		expect(rawBody).not.toContain(secretAnswerBody);
		expect(rawBody).not.toContain(q1.questionId);
		expect(rawBody).not.toContain(blocked.questionId);
		expect(rawBody).not.toContain(alice.id);
		expect(rawBody).not.toContain(bob.id);
	});

	it("hides a bridge rejection across ask footer, GET /unread, and check_inbox until +60s while showing recipient decline immediately", async () => {
		const aliceAtT0 = await connect(aliceParticipantToken, { env, now: T0 });
		const blockedAsk = await call(aliceAtT0, "ask", {
			to: "bob",
			category: "schedule",
			question: "No allow rule exists",
		});
		expect(blockedAsk.isError).toBe(false);
		const blockedQuestionId = questionIdOf(blockedAsk.text);

		// Immediately at T0: hidden from ask footer, GET /unread, and check_inbox.
		expect(unreadCount(blockedAsk.text)).toBe(0);
		const unreadAtT0 = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			T0,
		);
		expect(unreadAtT0.status).toBe(200);
		expect(await unreadAtT0.json()).toEqual({ unread: 0 });
		const inboxAtT0 = await call(aliceAtT0, "check_inbox");
		expect(withoutFooter(inboxAtT0.text)).toBe("no new messages");

		// At T0 + 59_999ms: still hidden everywhere.
		const beforeBoundary = T0 + BRIDGE_REJECTION_DELAY_MS - 1;
		const unreadBefore = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			beforeBoundary,
		);
		expect(await unreadBefore.json()).toEqual({ unread: 0 });
		const aliceBefore = await connect(aliceParticipantToken, {
			env,
			now: beforeBoundary,
		});
		const inboxBefore = await call(aliceBefore, "check_inbox");
		expect(withoutFooter(inboxBefore.text)).toBe("no new messages");
		expect(unreadCount(inboxBefore.text)).toBe(0);

		// At T0 + 60_000ms: visible in GET /unread and delivered by check_inbox.
		const atBoundary = T0 + BRIDGE_REJECTION_DELAY_MS;
		const unreadAt = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			atBoundary,
		);
		expect(await unreadAt.json()).toEqual({ unread: 1 });
		const aliceAt = await connect(aliceParticipantToken, {
			env,
			now: atBoundary,
		});
		const inboxAt = await call(aliceAt, "check_inbox");
		expect(withoutFooter(inboxAt.text)).toMatch(
			new RegExp(
				`^messages: 1\\n\\nkind: rejection\\nmessage_id: \\S+\\nquestion_id: ${blockedQuestionId}$`,
			),
		);
		expect(unreadCount(inboxAt.text)).toBe(0);

		// Recipient decline remains immediately visible in GET /unread without delay.
		const accepted = await submitQuestion(db, {
			fromAgentId: alice.id,
			toAgentId: bob.id,
			categoryId: schedule.id,
			body: "Will you decline?",
			now: atBoundary,
		});
		const declined = await answerQuestion(db, {
			questionId: accepted.questionId,
			responderAgentId: bob.id,
			reply: { kind: "decline" },
			now: atBoundary + 1000,
		});
		expect(declined.ok).toBe(true);

		const unreadAfterDecline = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			atBoundary + 1000,
		);
		expect(await unreadAfterDecline.json()).toEqual({ unread: 1 });
	});

	it("is read-only: repeated calls do not mark messages received and check_inbox still delivers them", async () => {
		const q = await submitQuestion(db, {
			fromAgentId: bob.id,
			toAgentId: alice.id,
			categoryId: schedule.id,
			body: "Please keep me unread",
			now: T0,
		});

		for (let i = 0; i < 3; i++) {
			const res = await unreadGet(
				`Bearer ${aliceUnreadToken}`,
				UNREAD_URL,
				T0 + (i + 1) * 1000,
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ unread: 1 });
		}

		// received_at in DB must still be NULL.
		const row = await db
			.prepare("SELECT received_at FROM messages WHERE id = ?")
			.bind(q.questionId)
			.first<{ received_at: number | null }>();
		expect(row?.received_at).toBeNull();

		// Real MCP check_inbox still delivers the message.
		const client = await connect(aliceParticipantToken, {
			env,
			now: T0 + 5000,
		});
		const inbox = await call(client, "check_inbox");
		expect(inbox.isError).toBe(false);
		expect(inbox.text).toContain("Please keep me unread");
		expect(inbox.text).toContain(q.questionId);

		// After check_inbox consumes it, /unread returns 0.
		const afterFetch = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			T0 + 6000,
		);
		expect(afterFetch.status).toBe(200);
		expect(await afterFetch.json()).toEqual({ unread: 0 });
	});

	it("enforces strict token purpose separation across /unread, /mcp, and /mcp/admin", async () => {
		// participant token rejected on /unread with 401 and auth_failed audit log.
		const participantOnUnread = await unreadGet(
			`Bearer ${aliceParticipantToken}`,
			UNREAD_URL,
			T0 + 10,
		);
		expect(participantOnUnread.status).toBe(401);
		expect(participantOnUnread.headers.get("WWW-Authenticate")).toBe("Bearer");
		expect(participantOnUnread.headers.get("Cache-Control")).toBe("no-store");
		expect(await participantOnUnread.text()).toBe("");

		// admin token rejected on /unread with 401 and auth_failed audit log.
		const adminOnUnread = await unreadGet(
			`Bearer ${aliceAdminToken}`,
			UNREAD_URL,
			T0 + 20,
		);
		expect(adminOnUnread.status).toBe(401);
		expect(adminOnUnread.headers.get("WWW-Authenticate")).toBe("Bearer");
		expect(adminOnUnread.headers.get("Cache-Control")).toBe("no-store");
		expect(await adminOnUnread.text()).toBe("");

		// unread_count token rejected on /mcp with 401.
		const unreadOnMcp = await handleMcpRequest(
			mcpPostRequest(MCP_URL, aliceUnreadToken),
			env,
			T0 + 30,
		);
		expect(unreadOnMcp.status).toBe(401);
		expect(unreadOnMcp.headers.get("WWW-Authenticate")).toBe("Bearer");

		// unread_count token rejected on /mcp/admin with 401 (even though alice is designated admin bot).
		const unreadOnAdminMcp = await handleAdminMcpRequest(
			mcpPostRequest(ADMIN_MCP_URL, aliceUnreadToken),
			env,
			T0 + 40,
		);
		expect(unreadOnAdminMcp.status).toBe(401);
		expect(unreadOnAdminMcp.headers.get("WWW-Authenticate")).toBe("Bearer");

		const audits = await authFailedAudits();
		expect(audits).toHaveLength(4);
		for (const entry of audits) {
			expect(entry.fromAgentId).toBe(alice.id);
			expect(entry.reasonCode).toBe("token_unknown");
		}
	});

	it("rejects query parameter ?token=... without Authorization header and missing/invalid tokens with 401", async () => {
		const queryTokenRes = await unreadGet(
			null,
			`${UNREAD_URL}?token=${encodeURIComponent(aliceUnreadToken)}`,
			T0 + 10,
		);
		expect(queryTokenRes.status).toBe(401);
		expect(queryTokenRes.headers.get("WWW-Authenticate")).toBe("Bearer");
		expect(queryTokenRes.headers.get("Cache-Control")).toBe("no-store");
		expect(await queryTokenRes.text()).toBe("");

		const unknownRes = await unreadGet(
			"Bearer paab_unknown_token_value_12345678901234567890",
			UNREAD_URL,
			T0 + 20,
		);
		expect(unknownRes.status).toBe(401);
		expect(unknownRes.headers.get("Cache-Control")).toBe("no-store");

		const audits = await authFailedAudits();
		expect(audits.map((entry) => entry.reasonCode)).toEqual([
			"token_missing",
			"token_unknown",
		]);
	});

	it("rejects non-GET methods (POST, HEAD, PUT) with 405 and Allow: GET", async () => {
		for (const method of ["POST", "HEAD", "PUT", "DELETE"]) {
			const res = await handleUnreadRequest(
				new Request(UNREAD_URL, {
					method,
					headers: { Authorization: `Bearer ${aliceUnreadToken}` },
				}),
				env,
				T0 + 10,
			);
			expect(res.status).toBe(405);
			expect(res.headers.get("Allow")).toBe("GET");
			expect(res.headers.get("Cache-Control")).toBe("no-store");
		}

		// Method guard rejects before authentication, so no auth_failed rows were recorded.
		expect(await authFailedAudits()).toHaveLength(0);
	});

	it("returns 403 and logs sender_suspended for a suspended agent, then restores access on resume", async () => {
		await submitQuestion(db, {
			fromAgentId: bob.id,
			toAgentId: alice.id,
			categoryId: schedule.id,
			body: "Waiting while suspended",
			now: T0,
		});

		const suspended = await suspendAgent(db, {
			agentId: alice.id,
			actor: OWNER,
			now: T0 + 10,
		});
		expect(suspended.ok).toBe(true);

		const res = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			T0 + 20,
		);
		expect(res.status).toBe(403);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(await res.text()).toBe("agent suspended");

		const audits = await authFailedAudits();
		expect(audits).toHaveLength(1);
		expect(audits[0]?.fromAgentId).toBe(alice.id);
		expect(audits[0]?.reasonCode).toBe("sender_suspended");

		const resumed = await resumeAgent(db, {
			agentId: alice.id,
			actor: OWNER,
			now: T0 + 30,
		});
		expect(resumed.ok).toBe(true);

		const afterResume = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			T0 + 40,
		);
		expect(afterResume.status).toBe(200);
		expect(await afterResume.json()).toEqual({ unread: 1 });
	});

	it("immediately invalidates old unread_count tokens on reissue or revoke without affecting participant tokens", async () => {
		// Reissue unread_count token.
		const reissued = await issueAgentToken(db, {
			agentId: alice.id,
			purpose: "unread_count",
			actor: OWNER,
			now: T0 + 10,
		});
		expect(reissued.ok).toBe(true);
		if (!reissued.ok) throw new Error("expected reissue to succeed");
		expect(reissued.data.revokedPrevious).toBe(true);
		const token2 = reissued.data.token;
		expect(token2).not.toBe(aliceUnreadToken);

		const oldRes = await unreadGet(
			`Bearer ${aliceUnreadToken}`,
			UNREAD_URL,
			T0 + 20,
		);
		expect(oldRes.status).toBe(401);

		const newRes = await unreadGet(`Bearer ${token2}`, UNREAD_URL, T0 + 20);
		expect(newRes.status).toBe(200);
		expect(await newRes.json()).toEqual({ unread: 0 });

		// Revoke unread_count token.
		const revoked = await revokeAgentTokens(db, {
			agentId: alice.id,
			purpose: "unread_count",
			actor: OWNER,
			now: T0 + 30,
		});
		expect(revoked.ok).toBe(true);
		if (!revoked.ok) throw new Error("expected revoke to succeed");
		expect(revoked.data.revokedCount).toBe(1);

		const revokedRes = await unreadGet(`Bearer ${token2}`, UNREAD_URL, T0 + 40);
		expect(revokedRes.status).toBe(401);

		// Participant token still works on /mcp.
		const mcpRes = await handleMcpRequest(
			mcpPostRequest(MCP_URL, aliceParticipantToken),
			env,
			T0 + 40,
		);
		expect(mcpRes.status).toBe(200);

		const audits = await authFailedAudits();
		expect(audits).toHaveLength(2);
		for (const entry of audits) {
			expect(entry.fromAgentId).toBe(alice.id);
			expect(entry.reasonCode).toBe("token_revoked");
		}
	});

	it("routes GET /unread directly through Worker fetch (SELF.fetch) outside /admin", async () => {
		const now = Date.now();
		await submitQuestion(db, {
			fromAgentId: bob.id,
			toAgentId: alice.id,
			categoryId: schedule.id,
			body: "Routed via SELF.fetch",
			now: now - HOUR_MS,
		});
		// Also insert an expired question relative to Date.now() so SELF.fetch excludes it.
		await submitQuestion(db, {
			fromAgentId: bob.id,
			toAgentId: alice.id,
			categoryId: schedule.id,
			body: "Already expired",
			now: now - QUESTION_TTL_MS - DAY_MS,
		});

		const okRes = await SELF.fetch("http://example.com/unread", {
			method: "GET",
			headers: { Authorization: `Bearer ${aliceUnreadToken}` },
		});
		expect(okRes.status).toBe(200);
		expect(okRes.headers.get("Content-Type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(okRes.headers.get("Cache-Control")).toBe("no-store");
		expect(await okRes.json()).toEqual({ unread: 1 });

		// Ensure SELF.fetch did not consume the inbox message.
		const items = await fetchInbox(db, alice.id, now);
		expect(items).toHaveLength(1);

		// Non-GET routed through Worker returns 405 with Allow: GET.
		const postRes = await SELF.fetch("http://example.com/unread", {
			method: "POST",
			headers: { Authorization: `Bearer ${aliceUnreadToken}` },
		});
		expect(postRes.status).toBe(405);
		expect(postRes.headers.get("Allow")).toBe("GET");

		// Missing auth routed through Worker returns 401 (not 503 from /admin Access).
		const unauthRes = await SELF.fetch("http://example.com/unread");
		expect(unauthRes.status).toBe(401);
		expect(unauthRes.headers.get("WWW-Authenticate")).toBe("Bearer");
	});
});
