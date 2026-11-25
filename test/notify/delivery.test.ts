import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ChangeActor,
	configureAgentWebhook,
	deleteAgentWebhook,
	suspendAgent,
} from "../../src/admin";
import { queryAuditLog } from "../../src/audit";
import type { WebhookDeliveryRow } from "../../src/db";
import { runScheduledMaintenance } from "../../src/mcp";
import type { McpEnv } from "../../src/mcp/config";
import {
	MAX_WEBHOOK_ATTEMPTS,
	signWebhookPayload,
	WEBHOOK_BLOCKED_DELAY_MS,
	WEBHOOK_BODY,
	WEBHOOK_RETRY_DELAYS_MS,
	type WebhookFetcher,
} from "../../src/notify";
import { DAY_MS, T0 } from "../helpers/fixtures";
import {
	askBob,
	call,
	connect,
	createMcpWorld,
	type McpWorld,
} from "../mcp/support";

const OWNER: ChangeActor = { actorType: "owner", actorId: "owner@example.com" };

interface CapturedCall {
	url: string;
	method: string;
	headers: Headers;
	body: string;
	redirect: RequestInit["redirect"];
	hasSignal: boolean;
}

let world: McpWorld;

beforeEach(async () => {
	world = await createMcpWorld();
});

async function deliveriesFor(agentId: string): Promise<WebhookDeliveryRow[]> {
	const { results } = await world.db
		.prepare(
			"SELECT * FROM webhook_deliveries WHERE agent_id = ? ORDER BY created_at, id",
		)
		.bind(agentId)
		.all<WebhookDeliveryRow>();
	return results;
}

function mockFetcher(
	handler: (call: CapturedCall, index: number) => Promise<Response> | Response,
): { fetcher: WebhookFetcher; calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	const fetcher: WebhookFetcher = async (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		const call: CapturedCall = {
			url,
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? init.body : "",
			redirect: init?.redirect,
			hasSignal: init?.signal !== undefined,
		};
		calls.push(call);
		return handler(call, calls.length);
	};
	return { fetcher, calls };
}

function mcpEnv(fetcher: WebhookFetcher, allowLocal = false): McpEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: "true",
		AUDIT_BODY_RETENTION_DAYS: "30",
		ALLOW_LOCAL_WEBHOOKS: allowLocal ? "true" : "false",
		webhookFetcher: fetcher,
	};
}

async function verifySignature(
	secret: string,
	call: CapturedCall,
): Promise<boolean> {
	const timestamp = call.headers.get("X-Paab-Timestamp");
	const signature = call.headers.get("X-Paab-Signature");
	if (!timestamp || !signature) return false;
	const expected = await signWebhookPayload(secret, timestamp, call.body);
	return signature === expected;
}

describe("webhook delivery & HMAC signing", () => {
	it("wakes recipient on accepted ask via waitUntil with fixed body and valid HMAC signature, and wakes asker on answer and decline", async () => {
		const bobHook = await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://bob.example/wake",
			actor: OWNER,
			now: T0,
		});
		const aliceHook = await configureAgentWebhook(world.db, {
			agentId: world.alice.agent.id,
			url: "https://alice.example/wake",
			actor: OWNER,
			now: T0,
		});
		expect(bobHook.ok && aliceHook.ok).toBe(true);
		if (!bobHook.ok || !aliceHook.ok) return;

		let releaseFetch!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		const { fetcher, calls } = mockFetcher(async () => {
			await gate;
			return new Response(null, { status: 204 });
		});

		const execCtx = createExecutionContext();
		const askTime = T0 + 1000;
		const alice = await connect(world.alice.token, {
			env: mcpEnv(fetcher),
			now: askTime,
			executionCtx: execCtx,
		});

		const secretQuestion = "SECRET_QUESTION_BODY_MUST_NOT_LEAK";
		const questionId = await askBob(alice, secretQuestion);
		// ask must return before the slow webhook fetch resolves when waitUntil is used.
		expect(calls).toHaveLength(1);
		expect((await deliveriesFor(world.bob.agent.id))[0]?.status).toBe(
			"pending",
		);

		releaseFetch();
		await waitOnExecutionContext(execCtx);

		expect(calls[0]?.url).toBe("https://bob.example/wake");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.redirect).toBe("error");
		expect(calls[0]?.hasSignal).toBe(true);
		expect(calls[0]?.body).toBe(WEBHOOK_BODY);
		expect(calls[0]?.body).not.toContain(secretQuestion);
		expect(calls[0]?.body).not.toContain(questionId);
		expect(calls[0]?.body).not.toContain("alice");
		expect(calls[0]?.body).not.toContain("schedule");
		expect(calls[0]?.headers.get("X-Paab-Timestamp")).toBe(
			String(Math.floor(askTime / 1000)),
		);
		expect(
			await verifySignature(
				bobHook.data.signingSecret,
				calls[0] as CapturedCall,
			),
		).toBe(true);

		expect(await deliveriesFor(world.bob.agent.id)).toMatchObject([
			{ status: "delivered", attempts: 1, last_error: null },
		]);

		// Now bob answers -> wakes alice immediately.
		const bob = await connect(world.bob.token, {
			env: mcpEnv(fetcher),
			now: T0 + 2000,
		});
		await call(bob, "answer", {
			question_id: questionId,
			action: "answer",
			text: "SECRET_ANSWER_BODY",
		});

		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toBe("https://alice.example/wake");
		expect(calls[1]?.body).toBe(WEBHOOK_BODY);
		expect(calls[1]?.body).not.toContain("SECRET_ANSWER_BODY");
		expect(
			await verifySignature(
				aliceHook.data.signingSecret,
				calls[1] as CapturedCall,
			),
		).toBe(true);

		// Second question declined by bob -> wakes alice again.
		const q2 = await askBob(alice, "Second question?");
		await waitOnExecutionContext(execCtx);
		await call(bob, "answer", { question_id: q2, action: "decline" });

		expect(calls).toHaveLength(4);
		expect(calls[3]?.url).toBe("https://alice.example/wake");
		expect(calls[3]?.body).toBe(WEBHOOK_BODY);

		const audits = (await queryAuditLog(world.db)).filter(
			(e) => e.eventType === "webhook_notified",
		);
		expect(audits).toHaveLength(4);
		expect(
			audits.every((e) => e.outcome === "ok" && e.reasonCode === null),
		).toBe(true);
	});

	it("preserves #18 timing parity on bridge-blocked ask by enqueuing delayed delivery without inline HTTP fetch", async () => {
		const aliceHook = await configureAgentWebhook(world.db, {
			agentId: world.alice.agent.id,
			url: "https://alice.example/wake",
			actor: OWNER,
			now: T0,
		});
		expect(aliceHook.ok).toBe(true);

		const { fetcher, calls } = mockFetcher(
			() => new Response("ok", { status: 200 }),
		);
		const execCtx = createExecutionContext();
		const askTime = T0 + 5000;
		const alice = await connect(world.alice.token, {
			env: mcpEnv(fetcher),
			now: askTime,
			executionCtx: execCtx,
		});

		const res = await call(alice, "ask", {
			to: "bob",
			category: "health",
			question: "Blocked question",
		});
		expect(res.isError).toBe(false);
		await waitOnExecutionContext(execCtx);

		expect(calls).toHaveLength(0);
		expect(await deliveriesFor(world.alice.agent.id)).toMatchObject([
			{
				status: "pending",
				attempts: 0,
				next_attempt_at: askTime + WEBHOOK_BLOCKED_DELAY_MS,
			},
		]);

		// Maintenance before the delay does not fire; maintenance at deadline delivers it.
		await runScheduledMaintenance(
			mcpEnv(fetcher),
			askTime + WEBHOOK_BLOCKED_DELAY_MS - 1,
		);
		expect(calls).toHaveLength(0);

		await runScheduledMaintenance(
			mcpEnv(fetcher),
			askTime + WEBHOOK_BLOCKED_DELAY_MS,
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://alice.example/wake");
		expect(await deliveriesFor(world.alice.agent.id)).toMatchObject([
			{ status: "delivered", attempts: 1 },
		]);
	});

	it("coalesces bursts of pending deliveries into one row and pulls forward a delayed row when an immediate wake arrives", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.alice.agent.id,
			url: "https://alice.example/wake",
			actor: OWNER,
			now: T0,
		});
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://bob.example/wake",
			actor: OWNER,
			now: T0,
		});

		let attempt = 0;
		const { fetcher, calls } = mockFetcher(() => {
			attempt += 1;
			return attempt === 1
				? new Response("down", { status: 503 })
				: new Response("ok", { status: 200 });
		});

		const alice = await connect(world.alice.token, {
			env: mcpEnv(fetcher),
			now: T0 + 100,
		});

		// First accepted ask fails -> bob has 1 pending row in backoff (attempts = 1).
		await askBob(alice, "First");
		expect(calls).toHaveLength(1);
		expect(await deliveriesFor(world.bob.agent.id)).toHaveLength(1);

		// Burst of more asks while bob's delivery is pending/in backoff reuses the same row and does not spam fetches.
		await askBob(alice, "Second");
		await askBob(alice, "Third");
		expect(calls).toHaveLength(1);
		expect(await deliveriesFor(world.bob.agent.id)).toHaveLength(1);

		// Blocked ask for alice creates 1 delayed row; a second blocked ask coalesces into the same row.
		await call(alice, "ask", {
			to: "carol",
			category: "schedule",
			question: "q1",
		});
		await call(alice, "ask", {
			to: "carol",
			category: "schedule",
			question: "q2",
		});
		expect(await deliveriesFor(world.alice.agent.id)).toHaveLength(1);
		expect(calls).toHaveLength(1);

		// Delivering an answer to alice pulls her delayed row forward and wakes immediately.
		const bob = await connect(world.bob.token, {
			env: mcpEnv(fetcher),
			now: T0 + 200,
		});
		const bobInbox = await call(bob, "check_inbox");
		const firstQId = /^question_id: (\S+)$/m.exec(bobInbox.text)?.[1] ?? "";
		await call(bob, "answer", {
			question_id: firstQId,
			action: "answer",
			text: "Here",
		});

		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toBe("https://alice.example/wake");
		expect(await deliveriesFor(world.alice.agent.id)).toMatchObject([
			{ status: "delivered", attempts: 1 },
		]);
	});

	it("retries failed deliveries up to 3 attempts with bounded delays, records webhook_failed, and keeps inbox messages intact", async () => {
		expect(MAX_WEBHOOK_ATTEMPTS).toBe(3);
		expect(WEBHOOK_RETRY_DELAYS_MS).toEqual([0, 60_000, 300_000]);

		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://bob.example/wake",
			actor: OWNER,
			now: T0,
		});

		const { fetcher, calls } = mockFetcher(
			() =>
				new Response("upstream error", {
					status: 502,
					statusText: "Bad Gateway",
				}),
		);
		const alice = await connect(world.alice.token, {
			env: mcpEnv(fetcher),
			now: T0 + 1000,
		});
		await askBob(alice, "Important question");

		// Attempt 1 failed at T0 + 1000 -> backoff 60_000.
		expect(calls).toHaveLength(1);
		expect(await deliveriesFor(world.bob.agent.id)).toMatchObject([
			{
				status: "pending",
				attempts: 1,
				next_attempt_at: T0 + 1000 + 60_000,
				last_error: "HTTP 502 Bad Gateway",
			},
		]);

		// 1ms before retry 2 -> not due yet.
		await runScheduledMaintenance(mcpEnv(fetcher), T0 + 1000 + 60_000 - 1);
		expect(calls).toHaveLength(1);

		// Attempt 2 at T0 + 61_000 -> backoff 300_000.
		const t2 = T0 + 1000 + 60_000;
		await runScheduledMaintenance(mcpEnv(fetcher), t2);
		expect(calls).toHaveLength(2);
		expect(await deliveriesFor(world.bob.agent.id)).toMatchObject([
			{
				status: "pending",
				attempts: 2,
				next_attempt_at: t2 + 300_000,
			},
		]);

		// Attempt 3 at t2 + 300_000 -> abandoned + webhook_failed audit.
		const t3 = t2 + 300_000;
		await runScheduledMaintenance(mcpEnv(fetcher), t3);
		expect(calls).toHaveLength(3);
		expect(await deliveriesFor(world.bob.agent.id)).toMatchObject([
			{
				status: "abandoned",
				attempts: 3,
				last_error: "HTTP 502 Bad Gateway",
			},
		]);

		// Subsequent maintenance does not retry abandoned deliveries.
		await runScheduledMaintenance(mcpEnv(fetcher), t3 + DAY_MS);
		expect(calls).toHaveLength(3);

		const failedAudits = (await queryAuditLog(world.db)).filter(
			(e) => e.eventType === "webhook_failed",
		);
		expect(failedAudits).toEqual([
			expect.objectContaining({
				occurredAt: t3,
				eventType: "webhook_failed",
				toAgentId: world.bob.agent.id,
				outcome: "denied",
				reasonCode: "webhook_delivery_failed",
			}),
		]);

		// Question remains intact in bob's inbox.
		const bob = await connect(world.bob.token, {
			env: mcpEnv(fetcher),
			now: t3 + 1,
		});
		const inbox = await call(bob, "check_inbox");
		expect(inbox.text).toContain("Important question");
	});

	it("re-checks SSRF rules right before dispatching and rejects local URLs when ALLOW_LOCAL_WEBHOOKS is turned off", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "http://127.0.0.1:8788/wake",
			allowLocal: true,
			actor: OWNER,
			now: T0,
		});

		const { fetcher, calls } = mockFetcher(
			() => new Response("ok", { status: 200 }),
		);
		// Production env with ALLOW_LOCAL_WEBHOOKS off blocks dispatch without calling fetcher.
		const alice = await connect(world.alice.token, {
			env: mcpEnv(fetcher, false),
			now: T0 + 100,
		});
		await askBob(alice, "Question");
		expect(calls).toHaveLength(0);
		expect(await deliveriesFor(world.bob.agent.id)).toMatchObject([
			{
				status: "pending",
				attempts: 1,
				last_error: expect.stringContaining("https://"),
			},
		]);

		await runScheduledMaintenance(mcpEnv(fetcher, false), T0 + 100 + 60_000);
		await runScheduledMaintenance(
			mcpEnv(fetcher, false),
			T0 + 100 + 60_000 + 300_000,
		);
		expect(calls).toHaveLength(0);
		expect(await deliveriesFor(world.bob.agent.id)).toMatchObject([
			{ status: "abandoned", attempts: 3 },
		]);

		// With ALLOW_LOCAL_WEBHOOKS=true, a fresh wakeup succeeds.
		const bob2 = await connect(world.bob.token, {
			env: mcpEnv(fetcher, true),
			now: T0 + 500_000,
		});
		const alice2 = await connect(world.alice.token, {
			env: mcpEnv(fetcher, true),
			now: T0 + 500_000,
		});
		await askBob(alice2, "Local allowed");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:8788/wake");
		expect((await call(bob2, "check_inbox")).text).toContain("Local allowed");
	});

	it("wakes askers when questions expire in runScheduledMaintenance and isolates webhook step failures", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.alice.agent.id,
			url: "https://alice.example/wake",
			actor: OWNER,
			now: T0,
		});

		const { fetcher, calls } = mockFetcher(
			() => new Response("ok", { status: 200 }),
		);
		const alice = await connect(world.alice.token, {
			env: mcpEnv(fetcher),
			now: T0,
		});
		await askBob(alice, "Will expire");
		expect(calls).toHaveLength(0);

		const expiryTime = T0 + 7 * DAY_MS;
		await runScheduledMaintenance(mcpEnv(fetcher), expiryTime);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://alice.example/wake");
		expect(await deliveriesFor(world.alice.agent.id)).toMatchObject([
			{ status: "delivered", attempts: 1 },
		]);

		// Failure in webhook_deliveries step must not block inbox expiry or audit body purge.
		const failingWebhookDb = {
			prepare(sql: string) {
				if (sql.includes("SELECT d.*, w.url")) {
					return {
						bind: () => ({
							all: () => Promise.reject(new Error("webhook table down")),
						}),
					};
				}
				return world.db.prepare(sql);
			},
			batch: world.db.batch.bind(world.db),
		} as unknown as D1Database;

		await connect(world.alice.token, {
			env: mcpEnv(fetcher),
			now: expiryTime + 1000,
		}).then((client) => askBob(client, "Second will expire"));

		await expect(
			runScheduledMaintenance(
				{
					DB: failingWebhookDb,
					AUDIT_RECORD_BODIES: "true",
					AUDIT_BODY_RETENTION_DAYS: "30",
					webhookFetcher: fetcher,
				},
				expiryTime + 1000 + 7 * DAY_MS,
			),
		).rejects.toThrow("webhook table down");

		const expiredAudits = (await queryAuditLog(world.db)).filter(
			(e) => e.eventType === "question_expired",
		);
		expect(expiredAudits).toHaveLength(2);
	});

	it("never dispatches webhooks to suspended agents or after webhook deletion", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://bob.example/wake",
			actor: OWNER,
			now: T0,
		});
		const { fetcher, calls } = mockFetcher(
			() => new Response("down", { status: 500 }),
		);

		const alice = await connect(world.alice.token, {
			env: mcpEnv(fetcher),
			now: T0 + 100,
		});
		await askBob(alice, "Before suspend");
		expect(calls).toHaveLength(1);

		await suspendAgent(world.db, {
			agentId: world.bob.agent.id,
			actor: OWNER,
			now: T0 + 200,
		});
		await runScheduledMaintenance(mcpEnv(fetcher), T0 + 100 + 60_000);
		expect(calls).toHaveLength(1);
		expect(await deliveriesFor(world.bob.agent.id)).toMatchObject([
			{ status: "abandoned", last_error: "agent suspended" },
		]);

		await deleteAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			actor: OWNER,
			now: T0 + 300,
		});
		expect(await deliveriesFor(world.bob.agent.id)).toHaveLength(1);
	});

	it("records network throws as failed attempts and avoids hanging when fetcher rejects", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://bob.example/wake",
			actor: OWNER,
			now: T0,
		});
		const spy = vi.fn(async () => {
			throw new TypeError("redirect encountered");
		});
		const alice = await connect(world.alice.token, {
			env: mcpEnv(spy),
			now: T0 + 10,
		});
		await askBob(alice, "Network error test");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(await deliveriesFor(world.bob.agent.id)).toMatchObject([
			{
				status: "pending",
				attempts: 1,
				last_error: "redirect encountered",
			},
		]);
	});
});
