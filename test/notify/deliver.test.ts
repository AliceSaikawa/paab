import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureAgentWebhook, suspendAgent } from "../../src/admin";
import { AUDIT_BODY_RECORDING_DISABLED, queryAuditLog } from "../../src/audit";
import {
	insertAuditLogEntry,
	upsertAgentWebhook,
	type WebhookDeliveryRow,
	webhookDeliveryFromRow,
} from "../../src/db";
import worker from "../../src/index";
import {
	HOURLY_MAINTENANCE_CRON,
	handleMcpRequest,
	type McpRequestOptions,
	runScheduledMaintenance,
	WEBHOOK_POLL_CRON,
} from "../../src/mcp";
import type { McpEnv } from "../../src/mcp/config";
import {
	attemptWebhookDelivery,
	DEFAULT_DUE_WEBHOOK_LIMIT,
	enqueueWake,
	notifyAgentImmediately,
	processDueWebhooks,
	purgeFinishedWebhookDeliveries,
	sanitizeWebhookError,
	WAKE_PAYLOAD,
	WEBHOOK_BLOCKED_DELAY_MS,
	WEBHOOK_DELIVERY_RETENTION_MS,
	WEBHOOK_IN_FLIGHT_LEASE_MS,
	WEBHOOK_RETRY_DELAYS_MS,
	type WebhookFetcher,
} from "../../src/notify";
import { DAY_MS, seedAgent, T0 } from "../helpers/fixtures";
import {
	askBob,
	call,
	createMcpWorld,
	MCP_URL,
	type McpWorld,
} from "../mcp/support";

const OWNER = { actorType: "owner" as const, actorId: "owner@example.com" };
const WHSEC_KEY = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;

let world: McpWorld;

beforeEach(async () => {
	world = await createMcpWorld();
});

function mcpEnv(overrides: Partial<McpEnv> = {}): McpEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: "false",
		AUDIT_BODY_RETENTION_DAYS: "30",
		...overrides,
	};
}

async function connectWithOptions(
	token: string,
	options: {
		now?: number;
		env?: McpEnv;
		mcpOptions?: McpRequestOptions;
	} = {},
): Promise<Client> {
	const client = new Client({ name: "paab-webhook-test", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
		fetch: (input, init) =>
			handleMcpRequest(
				new Request(input, init),
				options.env ?? mcpEnv(),
				options.now ?? T0,
				options.mcpOptions,
			),
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	await client.connect(transport);
	return client;
}

async function listDeliveries(agentId?: string) {
	const stmt =
		agentId === undefined
			? world.db.prepare(
					"SELECT * FROM webhook_deliveries ORDER BY created_at ASC",
				)
			: world.db
					.prepare(
						"SELECT * FROM webhook_deliveries WHERE agent_id = ? ORDER BY created_at ASC",
					)
					.bind(agentId);
	const { results } = await stmt.all<WebhookDeliveryRow>();
	return results.map(webhookDeliveryFromRow);
}

describe("webhook delivery across all 4 auth modes", () => {
	it.each([
		{
			authMode: "standard_webhooks" as const,
			secret: WHSEC_KEY,
			assertHeaders: (headers: Headers, deliveryId: string) => {
				expect(headers.get("webhook-id")).toBe(deliveryId);
				expect(headers.get("webhook-timestamp")).toBe(
					String(Math.floor(T0 / 1000)),
				);
				expect(headers.get("webhook-signature")).toMatch(
					/^v1,[A-Za-z0-9+/=]+$/,
				);
			},
		},
		{
			authMode: "bearer_header" as const,
			secret: "bearer-secret-xyz",
			assertHeaders: (headers: Headers) => {
				expect(headers.get("authorization")).toBe("Bearer bearer-secret-xyz");
			},
		},
		{
			authMode: "custom_header" as const,
			headerName: "X-Wake-Secret",
			secret: "custom-secret-xyz",
			assertHeaders: (headers: Headers) => {
				expect(headers.get("x-wake-secret")).toBe("custom-secret-xyz");
			},
		},
		{
			authMode: "paab_hmac" as const,
			secret: undefined,
			assertHeaders: (headers: Headers) => {
				expect(headers.get("x-paab-timestamp")).toBe(
					String(Math.floor(T0 / 1000)),
				);
				expect(headers.get("x-paab-signature")).toMatch(
					/^sha256=[0-9a-f]{64}$/,
				);
			},
		},
	])(
		"delivers fixed bodyless wake payload with $authMode and records webhook_delivered",
		async ({ authMode, headerName, secret, assertHeaders }) => {
			const configured = await configureAgentWebhook(world.db, {
				agentId: world.bob.agent.id,
				url: "https://hooks.example.com/bob",
				authMode,
				headerName,
				secret,
				actor: OWNER,
				now: T0,
			});
			expect(configured.ok).toBe(true);

			const deliveryId = await enqueueWake(world.db, {
				agentId: world.bob.agent.id,
				now: T0,
			});
			expect(deliveryId).not.toBeNull();

			let capturedUrl = "";
			let capturedInit: RequestInit | undefined;
			const fetcher: WebhookFetcher = vi.fn(async (url, init) => {
				capturedUrl = url;
				capturedInit = init;
				return new Response("ok", { status: 200 });
			});

			const outcome = await attemptWebhookDelivery(
				world.db,
				deliveryId as string,
				{
					now: T0,
					audit: AUDIT_BODY_RECORDING_DISABLED,
					fetcher,
				},
			);
			expect(outcome).toEqual({ status: "delivered", attempts: 1 });
			expect(capturedUrl).toBe("https://hooks.example.com/bob");
			expect(capturedInit?.method).toBe("POST");
			expect(capturedInit?.redirect).toBe("manual");
			expect(capturedInit?.body).toBe(WAKE_PAYLOAD);
			expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);

			const headers = new Headers(capturedInit?.headers);
			expect(headers.get("content-type")).toBe("application/json");
			assertHeaders(headers, deliveryId as string);

			const audit = await queryAuditLog(world.db);
			expect(audit).toHaveLength(1);
			expect(audit[0]).toMatchObject({
				eventType: "webhook_delivered",
				toAgentId: world.bob.agent.id,
				outcome: "ok",
				reasonCode: null,
			});
		},
	);
});

describe("4 webhook triggers and non-blocking execution", () => {
	it("Trigger 1 (ask allowed): delivers immediately via waitUntil without delaying MCP response or leaking question data", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "paab_hmac",
			actor: OWNER,
			now: T0,
		});

		const pendingTasks: Promise<unknown>[] = [];
		let markFetchStarted!: () => void;
		const fetchStarted = new Promise<void>((resolve) => {
			markFetchStarted = resolve;
		});
		let releaseFetch!: () => void;
		const fetchGate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		let fetchCompleted = false;
		const calls: Array<{ url: string; body: unknown }> = [];
		const fetcher: WebhookFetcher = vi.fn(async (url, init) => {
			calls.push({ url, body: init?.body });
			markFetchStarted();
			await fetchGate;
			fetchCompleted = true;
			return new Response("accepted", { status: 202 });
		});

		const alice = await connectWithOptions(world.alice.token, {
			now: T0,
			mcpOptions: {
				waitUntil: (promise) => {
					pendingTasks.push(promise);
				},
				webhookFetcher: fetcher,
			},
		});

		const secretQuestion = "Top-secret dentist location on Friday?";
		const questionId = await askBob(alice, secretQuestion);

		// MCP response returned BEFORE the slow webhook fetch completed!
		expect(fetchCompleted).toBe(false);
		expect(pendingTasks).toHaveLength(1);
		await fetchStarted;
		expect(fetchCompleted).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://hooks.example.com/bob");
		expect(calls[0]?.body).toBe('{"event":"inbox_wake"}');
		expect(String(calls[0]?.body)).not.toContain(secretQuestion);
		expect(String(calls[0]?.body)).not.toContain(questionId);
		expect(String(calls[0]?.body)).not.toContain("alice");
		expect(String(calls[0]?.body)).not.toContain("schedule");

		// Release background fetch and verify completion.
		releaseFetch();
		await Promise.all(pendingTasks);
		expect(fetchCompleted).toBe(true);

		const deliveries = await listDeliveries(world.bob.agent.id);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toMatchObject({ status: "delivered", attempts: 1 });

		const audit = await queryAuditLog(world.db);
		expect(
			audit.some(
				(e) =>
					e.eventType === "webhook_delivered" &&
					e.toAgentId === world.bob.agent.id,
			),
		).toBe(true);
	});

	it("Trigger 2 (ask blocked): delays asker wake by 60s with NO immediate fetch, then delivers on cron at +60s", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.alice.agent.id,
			url: "https://hooks.example.com/alice",
			authMode: "bearer_header",
			secret: "alice-secret",
			actor: OWNER,
			now: T0,
		});
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "bearer_header",
			secret: "bob-secret",
			actor: OWNER,
			now: T0,
		});

		const pendingTasks: Promise<unknown>[] = [];
		const fetcher: WebhookFetcher = vi.fn(
			async () => new Response("ok", { status: 200 }),
		);

		const alice = await connectWithOptions(world.alice.token, {
			now: T0,
			mcpOptions: {
				waitUntil: (promise) => {
					pendingTasks.push(promise);
				},
				webhookFetcher: fetcher,
			},
		});

		// Ask Bob about disallowed category "health" -> bridge blocks it.
		const res = await call(alice, "ask", {
			to: "bob",
			category: "health",
			question: "What is my blood pressure?",
		});
		expect(res.isError).toBe(false);

		// Neither waitUntil nor immediate HTTP fetch was called!
		expect(pendingTasks).toHaveLength(0);
		expect(fetcher).not.toHaveBeenCalled();

		// Bob received NO wake; Alice has a 60s-delayed pending wake.
		expect(await listDeliveries(world.bob.agent.id)).toHaveLength(0);
		const aliceDeliveries = await listDeliveries(world.alice.agent.id);
		expect(aliceDeliveries).toHaveLength(1);
		expect(aliceDeliveries[0]).toMatchObject({
			status: "pending",
			attempts: 0,
			nextAttemptAt: T0 + WEBHOOK_BLOCKED_DELAY_MS,
		});

		// Cron before 60s does NOT deliver.
		await runScheduledMaintenance(mcpEnv(), T0 + WEBHOOK_BLOCKED_DELAY_MS - 1, {
			webhookFetcher: fetcher,
		});
		expect(fetcher).not.toHaveBeenCalled();

		// Cron at +60s DOES deliver to Alice.
		await runScheduledMaintenance(mcpEnv(), T0 + WEBHOOK_BLOCKED_DELAY_MS, {
			webhookFetcher: fetcher,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect((await listDeliveries(world.alice.agent.id))[0]?.status).toBe(
			"delivered",
		);
	});

	it("Trigger 3 (answer and decline): notifies asker immediately via waitUntil", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.alice.agent.id,
			url: "https://hooks.example.com/alice",
			authMode: "custom_header",
			headerName: "X-Alice-Key",
			secret: "alice-custom-secret",
			actor: OWNER,
			now: T0,
		});

		const alice = await connectWithOptions(world.alice.token, { now: T0 });
		const q1 = await askBob(alice, "Question 1?");
		const q2 = await askBob(alice, "Question 2?");

		const pendingTasks: Promise<unknown>[] = [];
		const fetcher: WebhookFetcher = vi.fn(
			async () => new Response("ok", { status: 200 }),
		);
		const bob = await connectWithOptions(world.bob.token, {
			now: T0 + 1000,
			mcpOptions: {
				waitUntil: (p) => {
					pendingTasks.push(p);
				},
				webhookFetcher: fetcher,
			},
		});

		// Answer q1 -> notifies Alice immediately.
		const ans = await call(bob, "answer", {
			question_id: q1,
			action: "answer",
			text: "Private answer text",
		});
		expect(ans.isError).toBe(false);
		await Promise.all(pendingTasks);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body).toBe(
			WAKE_PAYLOAD,
		);

		// Decline q2 -> notifies Alice immediately again.
		pendingTasks.length = 0;
		const dec = await call(bob, "answer", {
			question_id: q2,
			action: "decline",
		});
		expect(dec.isError).toBe(false);
		await Promise.all(pendingTasks);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("Trigger 4 (expireQuestions in maintenance): enqueues and delivers wake for expired-question asker", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.alice.agent.id,
			url: "https://hooks.example.com/alice",
			authMode: "standard_webhooks",
			secret: WHSEC_KEY,
			actor: OWNER,
			now: T0,
		});

		const alice = await connectWithOptions(world.alice.token, { now: T0 });
		await askBob(alice, "Unanswered Q1");
		await askBob(alice, "Unanswered Q2");

		const fetcher: WebhookFetcher = vi.fn(
			async () => new Response("ok", { status: 200 }),
		);

		// 7 days later: both questions expire; Alice receives one coalesced wake in the same run.
		await runScheduledMaintenance(mcpEnv(), T0 + 7 * DAY_MS + 1, {
			webhookFetcher: fetcher,
		});

		expect(fetcher).toHaveBeenCalledTimes(1);
		const deliveries = await listDeliveries(world.alice.agent.id);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.status).toBe("delivered");
	});
});

describe("coalescing, suspended agents, retries, redirect rejection, and secret redaction", () => {
	it("coalesces multiple pending wakes and preserves the earliest next_attempt_at via MIN", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "paab_hmac",
			actor: OWNER,
			now: T0,
		});

		// First: delayed wake at T0 + 60s.
		const id1 = await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0,
			delayMs: WEBHOOK_BLOCKED_DELAY_MS,
		});
		// Second: immediate wake at T0 + 5s -> coalesces into same row and pulls next_attempt_at earlier.
		const id2 = await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0 + 5_000,
			delayMs: 0,
		});
		// Third: another delayed wake at T0 + 6s + 60s -> keeps earlier T0 + 5s!
		const id3 = await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0 + 6_000,
			delayMs: WEBHOOK_BLOCKED_DELAY_MS,
		});

		expect(id1).not.toBeNull();
		expect(id2).toBe(id1);
		expect(id3).toBe(id1);

		const deliveries = await listDeliveries(world.bob.agent.id);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.nextAttemptAt).toBe(T0 + 5_000);
	});

	it("skips suspended agents and purges their pending deliveries without fetching", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "paab_hmac",
			actor: OWNER,
			now: T0,
		});

		const deliveryId = await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0,
		});
		expect(deliveryId).not.toBeNull();

		// Suspend Bob directly.
		await world.db
			.prepare("UPDATE agents SET status = 'suspended' WHERE id = ?")
			.bind(world.bob.agent.id)
			.run();

		// New enqueue skips suspended agent.
		expect(
			await enqueueWake(world.db, { agentId: world.bob.agent.id, now: T0 + 1 }),
		).toBeNull();

		const fetcher: WebhookFetcher = vi.fn(
			async () => new Response("ok", { status: 200 }),
		);

		// attemptWebhookDelivery deletes pending row and skips.
		const outcome = await attemptWebhookDelivery(
			world.db,
			deliveryId as string,
			{
				now: T0 + 1,
				audit: AUDIT_BODY_RECORDING_DISABLED,
				fetcher,
			},
		);
		expect(outcome).toEqual({ status: "skipped", reason: "agent_suspended" });
		expect(fetcher).not.toHaveBeenCalled();
		expect(await listDeliveries(world.bob.agent.id)).toHaveLength(0);

		// Re-seed a pending row directly while suspended and verify processDueWebhooks purges it.
		await world.db
			.prepare(
				`INSERT INTO webhook_deliveries
					(id, agent_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
				VALUES ('d-susp', ?, 'pending', 0, ?, NULL, ?, ?)`,
			)
			.bind(world.bob.agent.id, T0, T0, T0)
			.run();

		const result = await processDueWebhooks(world.db, {
			now: T0 + 10,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher,
		});
		expect(result.purged).toBe(1);
		expect(result.processed).toBe(0);
		expect(fetcher).not.toHaveBeenCalled();
		expect(await listDeliveries(world.bob.agent.id)).toHaveLength(0);
	});

	it("follows 3-attempt retry schedule (0s, 60s, 300s), abandons with audit log, and preserves inbox message", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "bearer_header",
			secret: "super-secret-token",
			actor: OWNER,
			now: T0,
		});

		// Alice asks Bob; Bob's webhook fails on every attempt.
		const alice = await connectWithOptions(world.alice.token, { now: T0 });
		const questionId = await askBob(alice, "Are you free tomorrow?");

		const failingFetcher: WebhookFetcher = vi.fn(
			async () => new Response("down", { status: 503 }),
		);

		// Attempt 1 at T0 (0s) -> fails, schedules retry at T0 + 60s.
		const r1 = await processDueWebhooks(world.db, {
			now: T0,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher: failingFetcher,
		});
		expect(r1).toMatchObject({ processed: 1, retried: 1, abandoned: 0 });
		let [delivery] = await listDeliveries(world.bob.agent.id);
		expect(delivery).toMatchObject({
			status: "pending",
			attempts: 1,
			nextAttemptAt: T0 + WEBHOOK_RETRY_DELAYS_MS[1],
			lastError: "HTTP 503",
		});

		// Before +60s -> not due yet.
		const rTooEarly = await processDueWebhooks(world.db, {
			now: T0 + WEBHOOK_RETRY_DELAYS_MS[1] - 1,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher: failingFetcher,
		});
		expect(rTooEarly.processed).toBe(0);

		// Attempt 2 at T0 + 60s -> fails, schedules retry at +300s (T0 + 360s).
		const t2 = T0 + WEBHOOK_RETRY_DELAYS_MS[1];
		const r2 = await processDueWebhooks(world.db, {
			now: t2,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher: failingFetcher,
		});
		expect(r2).toMatchObject({ processed: 1, retried: 1, abandoned: 0 });
		[delivery] = await listDeliveries(world.bob.agent.id);
		expect(delivery).toMatchObject({
			status: "pending",
			attempts: 2,
			nextAttemptAt: t2 + WEBHOOK_RETRY_DELAYS_MS[2],
			lastError: "HTTP 503",
		});

		// Before +300s -> not due yet.
		const rTooEarly2 = await processDueWebhooks(world.db, {
			now: t2 + WEBHOOK_RETRY_DELAYS_MS[2] - 1,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher: failingFetcher,
		});
		expect(rTooEarly2.processed).toBe(0);

		// Attempt 3 at t2 + 300s -> fails -> abandoned + webhook_abandoned audit log!
		const t3 = t2 + WEBHOOK_RETRY_DELAYS_MS[2];
		const r3 = await processDueWebhooks(world.db, {
			now: t3,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher: failingFetcher,
		});
		expect(r3).toMatchObject({ processed: 1, retried: 0, abandoned: 1 });
		[delivery] = await listDeliveries(world.bob.agent.id);
		expect(delivery).toMatchObject({
			status: "abandoned",
			attempts: 3,
			lastError: "HTTP 503",
		});

		const audit = await queryAuditLog(world.db);
		expect(
			audit.find((e) => e.eventType === "webhook_abandoned"),
		).toMatchObject({
			eventType: "webhook_abandoned",
			toAgentId: world.bob.agent.id,
			outcome: "denied",
			reasonCode: "webhook_delivery_failed",
		});

		// Crucially: the message is STILL preserved in Bob's inbox for check_inbox!
		const bob = await connectWithOptions(world.bob.token, { now: t3 + 1000 });
		const inbox = await call(bob, "check_inbox");
		expect(inbox.isError).toBe(false);
		expect(inbox.text).toContain(questionId);
		expect(inbox.text).toContain("Are you free tomorrow?");
	});

	it("rejects 3xx redirects without following them", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "paab_hmac",
			actor: OWNER,
			now: T0,
		});
		const deliveryId = await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0,
		});

		let seenRedirect: string | undefined;
		const fetcher: WebhookFetcher = vi.fn(async (_url, init) => {
			seenRedirect = init?.redirect;
			return new Response(null, {
				status: 302,
				headers: { Location: "http://169.254.169.254/latest/meta-data/" },
			});
		});

		const outcome = await attemptWebhookDelivery(
			world.db,
			deliveryId as string,
			{
				now: T0,
				audit: AUDIT_BODY_RECORDING_DISABLED,
				fetcher,
			},
		);
		expect(seenRedirect).toBe("manual");
		expect(outcome).toMatchObject({
			status: "retry_scheduled",
			attempts: 1,
			error: "HTTP 302 redirect rejected",
		});
	});

	it("redacts secrets and raw key substrings from last_error and truncates to 200 chars", async () => {
		const rawSuffix = btoa("0123456789abcdef0123456789abcdef");
		const secret = `whsec_${rawSuffix}`;
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "standard_webhooks",
			secret,
			actor: OWNER,
			now: T0,
		});
		const deliveryId = await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0,
		});

		const leakyFetcher: WebhookFetcher = vi.fn(async () => {
			throw new Error(
				`connection failed with ${secret} and raw=${rawSuffix} ${"x".repeat(300)}`,
			);
		});

		const outcome = await attemptWebhookDelivery(
			world.db,
			deliveryId as string,
			{
				now: T0,
				audit: AUDIT_BODY_RECORDING_DISABLED,
				fetcher: leakyFetcher,
			},
		);
		expect(outcome.status).toBe("retry_scheduled");
		if (outcome.status === "retry_scheduled") {
			expect(outcome.error).not.toContain(secret);
			expect(outcome.error).not.toContain(rawSuffix);
			expect(outcome.error).toContain("[redacted]");
			expect(outcome.error.length).toBeLessThanOrEqual(200);
		}

		// Also verify paab_hmac raw hex suffix redaction directly.
		const paabHex = "ab".repeat(32);
		const sanitized = sanitizeWebhookError(
			new Error(`boom paab_whsec_${paabHex} tail ${paabHex}`),
			{ authMode: "paab_hmac", secret: `paab_whsec_${paabHex}` },
		);
		expect(sanitized).not.toContain(paabHex);
		expect(sanitized).toContain("[redacted]");
	});

	it("re-validates SSRF on delivery if URL is disallowed without allowInsecureLocalhost", async () => {
		await upsertAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "http://127.0.0.1:8788/wake",
			authMode: "bearer_header",
			secret: "local-secret",
			createdAt: T0,
			updatedAt: T0,
		}).run();
		const deliveryId = await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0,
		});

		const fetcher: WebhookFetcher = vi.fn(
			async () => new Response("ok", { status: 200 }),
		);

		// Default (allowInsecureLocalhost: false) blocks without calling fetcher.
		const blocked = await attemptWebhookDelivery(
			world.db,
			deliveryId as string,
			{
				now: T0,
				audit: AUDIT_BODY_RECORDING_DISABLED,
				fetcher,
			},
		);
		expect(blocked.status).toBe("retry_scheduled");
		expect(fetcher).not.toHaveBeenCalled();

		// With allowInsecureLocalhost: true, delivers successfully.
		const allowed = await attemptWebhookDelivery(
			world.db,
			deliveryId as string,
			{
				now: T0 + WEBHOOK_RETRY_DELAYS_MS[1],
				audit: AUDIT_BODY_RECORDING_DISABLED,
				fetcher,
				allowInsecureLocalhost: true,
			},
		);
		expect(allowed).toEqual({ status: "delivered", attempts: 2 });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("handles timeout/abort errors cleanly and isolates webhook errors in scheduled maintenance", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "paab_hmac",
			actor: OWNER,
			now: T0,
		});
		const deliveryId = await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0,
		});

		const timeoutFetcher: WebhookFetcher = vi.fn(async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		const outcome = await attemptWebhookDelivery(
			world.db,
			deliveryId as string,
			{
				now: T0,
				audit: AUDIT_BODY_RECORDING_DISABLED,
				fetcher: timeoutFetcher,
			},
		);
		expect(outcome).toMatchObject({
			status: "retry_scheduled",
			attempts: 1,
			error: "The operation timed out.",
		});

		// Verify runScheduledMaintenance still expires overdue questions even if webhook delivery fails.
		const alice = await connectWithOptions(world.alice.token, { now: T0 });
		await askBob(alice, "Will expire despite webhook failure");
		await runScheduledMaintenance(mcpEnv(), T0 + 7 * DAY_MS + 1, {
			webhookFetcher: timeoutFetcher,
		});
		const expiredAudit = await queryAuditLog(world.db);
		expect(expiredAudit.some((e) => e.eventType === "question_expired")).toBe(
			true,
		);
	});

	it("preserves active retry backoff when new wakes arrive and prevents duplicate concurrent POSTs", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "paab_hmac",
			actor: OWNER,
			now: T0,
		});

		const deliveryId = await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0,
		});
		const failOnce: WebhookFetcher = vi.fn(
			async () => new Response("err", { status: 503 }),
		);
		const first = await attemptWebhookDelivery(world.db, deliveryId as string, {
			now: T0,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher: failOnce,
		});
		expect(first).toMatchObject({
			status: "retry_scheduled",
			attempts: 1,
			nextAttemptAt: T0 + WEBHOOK_RETRY_DELAYS_MS[1],
		});

		// A new immediate wake during backoff must coalesce without resetting next_attempt_at.
		await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0 + 10_000,
			delayMs: 0,
		});
		const pendingRows = await listDeliveries(world.bob.agent.id);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]?.attempts).toBe(1);
		expect(pendingRows[0]?.nextAttemptAt).toBe(T0 + WEBHOOK_RETRY_DELAYS_MS[1]);

		// Calling attemptWebhookDelivery before backoff elapses skips without POSTing.
		const earlyFetcher: WebhookFetcher = vi.fn(async () => new Response("ok"));
		const early = await attemptWebhookDelivery(world.db, deliveryId as string, {
			now: T0 + 10_000,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher: earlyFetcher,
		});
		expect(early).toEqual({ status: "skipped", reason: "not_due" });
		expect(earlyFetcher).not.toHaveBeenCalled();

		// Concurrent attempts once due must lease atomically so only one HTTP POST fires.
		let releaseFetch: (() => void) | undefined;
		const slowFetcher: WebhookFetcher = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					releaseFetch = () => resolve(new Response("ok", { status: 200 }));
				}),
		);
		const dueNow = T0 + WEBHOOK_RETRY_DELAYS_MS[1];
		const firstInFlight = attemptWebhookDelivery(
			world.db,
			deliveryId as string,
			{
				now: dueNow,
				audit: AUDIT_BODY_RECORDING_DISABLED,
				fetcher: slowFetcher,
			},
		);
		const secondInFlight = attemptWebhookDelivery(
			world.db,
			deliveryId as string,
			{
				now: dueNow,
				audit: AUDIT_BODY_RECORDING_DISABLED,
				fetcher: slowFetcher,
			},
		);
		await vi.waitFor(() => expect(slowFetcher).toHaveBeenCalledTimes(1));
		releaseFetch?.();
		const [r1, r2] = await Promise.all([firstInFlight, secondInFlight]);
		expect([r1.status, r2.status].sort()).toEqual(["delivered", "skipped"]);
		expect(slowFetcher).toHaveBeenCalledTimes(1);
	});

	it("immediately drops pending webhook deliveries when suspendAgent runs", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "paab_hmac",
			actor: OWNER,
			now: T0,
		});
		await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0,
		});
		expect(await listDeliveries(world.bob.agent.id)).toHaveLength(1);

		const suspended = await suspendAgent(world.db, {
			agentId: world.bob.agent.id,
			actor: OWNER,
			now: T0 + 1000,
		});
		expect(suspended.ok).toBe(true);
		expect(await listDeliveries(world.bob.agent.id)).toHaveLength(0);
	});

	it("prevents duplicate concurrent POSTs when a second notifyAgentImmediately arrives mid-flight on attempt 0", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "standard_webhooks",
			secret: WHSEC_KEY,
			actor: OWNER,
			now: T0,
		});

		let releaseFetch: (() => void) | undefined;
		const seenIds: string[] = [];
		const slowFetcher: WebhookFetcher = vi.fn((_input, init) => {
			const headers = new Headers(init?.headers);
			seenIds.push(headers.get("webhook-id") ?? "");
			return new Promise<Response>((resolve) => {
				releaseFetch = () => resolve(new Response("ok", { status: 200 }));
			});
		});

		const pendingTasks: Promise<unknown>[] = [];
		const waitUntil = (promise: Promise<unknown>) => {
			pendingTasks.push(promise);
		};

		// First immediate notification starts attempt 0 and holds the lease in-flight.
		await notifyAgentImmediately(world.db, {
			agentId: world.bob.agent.id,
			now: T0,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			waitUntil,
			fetcher: slowFetcher,
		});
		await vi.waitFor(() => expect(slowFetcher).toHaveBeenCalledTimes(1));

		const midFlightRows = await listDeliveries(world.bob.agent.id);
		expect(midFlightRows).toHaveLength(1);
		expect(midFlightRows[0]?.attempts).toBe(0);
		expect(midFlightRows[0]?.leasedUntil).toBe(T0 + WEBHOOK_IN_FLIGHT_LEASE_MS);

		// Second immediate notification arrives while attempt 0 is still mid-flight.
		// Must preserve leased_until and NOT schedule a second HTTP POST.
		await notifyAgentImmediately(world.db, {
			agentId: world.bob.agent.id,
			now: T0 + 100,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			waitUntil,
			fetcher: slowFetcher,
		});
		expect(pendingTasks).toHaveLength(1);
		expect(slowFetcher).toHaveBeenCalledTimes(1);

		const stillLeased = await listDeliveries(world.bob.agent.id);
		expect(stillLeased[0]?.leasedUntil).toBe(T0 + WEBHOOK_IN_FLIGHT_LEASE_MS);

		releaseFetch?.();
		await Promise.all(pendingTasks);

		expect(slowFetcher).toHaveBeenCalledTimes(1);
		expect(seenIds).toHaveLength(1);

		const deliveredRows = await listDeliveries(world.bob.agent.id);
		expect(deliveredRows).toHaveLength(1);
		expect(deliveredRows[0]?.status).toBe("delivered");
		expect(deliveredRows[0]?.attempts).toBe(1);
		expect(deliveredRows[0]?.leasedUntil).toBeNull();
	});

	it("recovers crashed deliveries via processDueWebhooks once leased_until expires", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "paab_hmac",
			actor: OWNER,
			now: T0,
		});
		const deliveryId = await enqueueWake(world.db, {
			agentId: world.bob.agent.id,
			now: T0,
		});
		const leaseExpiresAt = T0 + WEBHOOK_IN_FLIGHT_LEASE_MS;
		// Simulate a worker that acquired the lease and crashed before recording an outcome.
		await world.db
			.prepare(
				"UPDATE webhook_deliveries SET leased_until = ?, updated_at = ? WHERE id = ?",
			)
			.bind(leaseExpiresAt, T0, deliveryId)
			.run();

		const fetcher: WebhookFetcher = vi.fn(
			async () => new Response("ok", { status: 200 }),
		);

		// Before lease expiration: skipped by due query.
		const beforeExpiry = await processDueWebhooks(world.db, {
			now: leaseExpiresAt - 1,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher,
		});
		expect(beforeExpiry).toEqual({
			purged: 0,
			processed: 0,
			delivered: 0,
			retried: 0,
			abandoned: 0,
			skipped: 0,
		});
		expect(fetcher).not.toHaveBeenCalled();

		// At/after lease expiration: picked up, delivered, and leased_until cleared.
		const afterExpiry = await processDueWebhooks(world.db, {
			now: leaseExpiresAt,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher,
		});
		expect(afterExpiry).toEqual({
			purged: 0,
			processed: 1,
			delivered: 1,
			retried: 0,
			abandoned: 0,
			skipped: 0,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);

		const rows = await listDeliveries(world.bob.agent.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("delivered");
		expect(rows[0]?.leasedUntil).toBeNull();
	});

	it("separates per-minute webhook cron from hourly full maintenance in Worker scheduled", async () => {
		await configureAgentWebhook(world.db, {
			agentId: world.bob.agent.id,
			url: "https://hooks.example.com/bob",
			authMode: "paab_hmac",
			actor: OWNER,
			now: T0,
		});

		// Create an overdue question (expires at T0 + 7 days) and an audit row holding a body.
		const alice = await connectWithOptions(world.alice.token, { now: T0 });
		await askBob(alice, "Overdue question body");
		await insertAuditLogEntry(world.db, {
			occurredAt: T0,
			eventType: "question_accepted",
			fromAgentId: world.alice.agent.id,
			toAgentId: world.bob.agent.id,
			categoryId: world.schedule.id,
			outcome: "ok",
			reasonCode: null,
			messageId: null,
			body: "Audit body to purge on hourly cron",
		}).run();

		// Ensure one due webhook delivery is pending for Bob.
		await enqueueWake(world.db, { agentId: world.bob.agent.id, now: T0 });

		const dueNow = T0 + 7 * DAY_MS + 1;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("ok", { status: 200 }));
		vi.useFakeTimers({ toFake: ["Date"], now: dueNow });

		try {
			// 1. Per-minute cron ("* * * * *"): delivers due webhooks ONLY.
			const minuteCtx = createExecutionContext();
			await worker.scheduled(
				createScheduledController({
					cron: WEBHOOK_POLL_CRON,
					scheduledTime: dueNow,
				}),
				env,
				minuteCtx,
			);
			await waitOnExecutionContext(minuteCtx);

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect((await listDeliveries(world.bob.agent.id))[0]?.status).toBe(
				"delivered",
			);

			const qAfterMinute = await world.db
				.prepare("SELECT status, body FROM messages WHERE kind = 'question'")
				.first<{ status: string; body: string | null }>();
			expect(qAfterMinute?.status).toBe("pending");
			expect(qAfterMinute?.body).toBe("Overdue question body");

			const auditBodyAfterMinute = await world.db
				.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE body IS NOT NULL")
				.first<{ n: number }>();
			expect(auditBodyAfterMinute?.n).toBe(1);

			// 2. Hourly cron ("0 * * * *"): expires overdue questions, purges audit bodies, and delivers due webhooks.
			await enqueueWake(world.db, {
				agentId: world.bob.agent.id,
				now: dueNow,
			});
			const hourCtx = createExecutionContext();
			await worker.scheduled(
				createScheduledController({
					cron: HOURLY_MAINTENANCE_CRON,
					scheduledTime: dueNow,
				}),
				env,
				hourCtx,
			);
			await waitOnExecutionContext(hourCtx);

			expect(fetchSpy).toHaveBeenCalledTimes(2);

			const qAfterHour = await world.db
				.prepare("SELECT status, body FROM messages WHERE kind = 'question'")
				.first<{ status: string; body: string | null }>();
			expect(qAfterHour?.status).toBe("expired");
			expect(qAfterHour?.body).toBeNull();

			const auditBodyAfterHour = await world.db
				.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE body IS NOT NULL")
				.first<{ n: number }>();
			expect(auditBodyAfterHour?.n).toBe(0);
		} finally {
			vi.useRealTimers();
			fetchSpy.mockRestore();
		}
	});

	it("processes at most DEFAULT_DUE_WEBHOOK_LIMIT (8) due deliveries per processDueWebhooks call by default", async () => {
		expect(DEFAULT_DUE_WEBHOOK_LIMIT).toBe(8);

		for (let i = 0; i < 10; i += 1) {
			const agent = await seedAgent(world.db, { name: `agent-batch-${i}` });
			await configureAgentWebhook(world.db, {
				agentId: agent.id,
				url: `https://hooks.example.com/agent-${i}`,
				authMode: "paab_hmac",
				actor: OWNER,
				now: T0,
			});
			await enqueueWake(world.db, {
				agentId: agent.id,
				now: T0 + i,
			});
		}

		const fetcher: WebhookFetcher = vi.fn(
			async () => new Response("ok", { status: 200 }),
		);

		const firstPass = await processDueWebhooks(world.db, {
			now: T0 + 100,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher,
		});
		expect(firstPass).toEqual({
			purged: 0,
			processed: 8,
			delivered: 8,
			retried: 0,
			abandoned: 0,
			skipped: 0,
		});
		expect(fetcher).toHaveBeenCalledTimes(8);

		const remainingBeforeSecond = await world.db
			.prepare(
				"SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'pending'",
			)
			.first<{ n: number }>();
		expect(remainingBeforeSecond?.n).toBe(2);

		const secondPass = await processDueWebhooks(world.db, {
			now: T0 + 100,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher,
		});
		expect(secondPass).toEqual({
			purged: 0,
			processed: 2,
			delivered: 2,
			retried: 0,
			abandoned: 0,
			skipped: 0,
		});
		expect(fetcher).toHaveBeenCalledTimes(10);
	});

	it("purges delivered and abandoned webhook_deliveries at the 30-day boundary while keeping pending rows", async () => {
		expect(WEBHOOK_DELIVERY_RETENTION_MS).toBe(30 * DAY_MS);

		await world.db.batch([
			world.db
				.prepare(
					`INSERT INTO webhook_deliveries
						(id, agent_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
					VALUES (?, ?, 'delivered', 1, ?, NULL, ?, ?)`,
				)
				.bind("d-delivered-old", world.bob.agent.id, T0, T0, T0),
			world.db
				.prepare(
					`INSERT INTO webhook_deliveries
						(id, agent_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
					VALUES (?, ?, 'abandoned', 3, ?, 'HTTP 503', ?, ?)`,
				)
				.bind("d-abandoned-old", world.bob.agent.id, T0, T0, T0),
			world.db
				.prepare(
					`INSERT INTO webhook_deliveries
						(id, agent_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
					VALUES (?, ?, 'delivered', 1, ?, NULL, ?, ?)`,
				)
				.bind("d-delivered-fresh", world.bob.agent.id, T0, T0, T0 + 1),
			world.db
				.prepare(
					`INSERT INTO webhook_deliveries
						(id, agent_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
					VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?)`,
				)
				.bind("d-pending-old", world.alice.agent.id, T0 + 60 * DAY_MS, T0, T0),
		]);

		// One millisecond before 30 days: nothing deleted.
		expect(
			await purgeFinishedWebhookDeliveries(
				world.db,
				T0 + WEBHOOK_DELIVERY_RETENTION_MS - 1,
			),
		).toBe(0);
		expect(await listDeliveries()).toHaveLength(4);

		// At 30 days: old delivered and abandoned rows are deleted; fresh and pending stay.
		expect(
			await purgeFinishedWebhookDeliveries(
				world.db,
				T0 + WEBHOOK_DELIVERY_RETENTION_MS,
			),
		).toBe(2);
		expect((await listDeliveries()).map((d) => d.id).sort()).toEqual([
			"d-delivered-fresh",
			"d-pending-old",
		]);

		// Re-running is idempotent, and even 100 days later the pending row is never touched.
		expect(
			await purgeFinishedWebhookDeliveries(world.db, T0 + 100 * DAY_MS),
		).toBe(1);
		expect((await listDeliveries()).map((d) => d.id)).toEqual([
			"d-pending-old",
		]);
		expect(
			await purgeFinishedWebhookDeliveries(world.db, T0 + 100 * DAY_MS),
		).toBe(0);
	});

	it("keeps finished webhook_deliveries and other retention purges out of the per-minute cron", async () => {
		await world.db
			.prepare(
				`INSERT INTO webhook_deliveries
					(id, agent_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
				VALUES ('d-old-done', ?, 'delivered', 1, ?, NULL, ?, ?)`,
			)
			.bind(world.bob.agent.id, T0, T0, T0)
			.run();
		await world.db
			.prepare("UPDATE tokens SET revoked_at = ? WHERE agent_id = ?")
			.bind(T0, world.carol.agent.id)
			.run();

		const later = T0 + 30 * DAY_MS;
		vi.useFakeTimers({ toFake: ["Date"], now: later });
		try {
			const minuteCtx = createExecutionContext();
			await worker.scheduled(
				createScheduledController({
					cron: WEBHOOK_POLL_CRON,
					scheduledTime: later,
				}),
				env,
				minuteCtx,
			);
			await waitOnExecutionContext(minuteCtx);

			// Per-minute cron did NOT purge finished webhook deliveries or revoked tokens.
			expect((await listDeliveries()).map((d) => d.id)).toEqual(["d-old-done"]);
			const revokedCount = await world.db
				.prepare(
					"SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NOT NULL",
				)
				.first<{ n: number }>();
			expect(revokedCount?.n).toBe(1);

			// Hourly cron purges both.
			const hourCtx = createExecutionContext();
			await worker.scheduled(
				createScheduledController({
					cron: HOURLY_MAINTENANCE_CRON,
					scheduledTime: later,
				}),
				env,
				hourCtx,
			);
			await waitOnExecutionContext(hourCtx);

			expect(await listDeliveries()).toEqual([]);
			const revokedAfterHour = await world.db
				.prepare(
					"SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NOT NULL",
				)
				.first<{ n: number }>();
			expect(revokedAfterHour?.n).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
