import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	grantAllowRule,
	queryChangeLog,
	registerAgent,
	resumeAgent,
	updateAgent,
} from "../../../src/admin";
import {
	designateAdminBot,
	handleAdminMcpRequest,
	issueAdminBotToken,
	listPendingDescriptions,
	rejectPendingDescription,
	submitPendingDescription,
} from "../../../src/adminbot";
import {
	type AgentRow,
	agentFromRow,
	insertChangeLogEntry,
} from "../../../src/db";
import { checkQuestion } from "../../../src/policy";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { seedCategory, T0 } from "../../helpers/fixtures";
import { call } from "../../mcp/support";

const TEAM_DOMAIN = "paab-team.cloudflareaccess.com";
const TEST_AUD = "adminbot-undo-ui-aud";
const ADMIN_EMAIL = "owner-admin@example.com";
const ADMIN_MCP_URL = "https://paab.test/mcp/admin";

interface SigningKeyPair {
	kid: string;
	privateKey: CryptoKey;
	jwk: JwkKey;
}

let signingKey: SigningKeyPair;
let db: D1Database;

function toBase64Url(input: Uint8Array | string): string {
	const bytes =
		typeof input === "string" ? new TextEncoder().encode(input) : input;
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

async function generateSigningKey(kid: string): Promise<SigningKeyPair> {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	if (!("publicKey" in pair)) {
		throw new Error("Expected RSA key pair");
	}
	const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
	if (exported instanceof ArrayBuffer) {
		throw new Error("Expected JWK export");
	}
	return {
		kid,
		privateKey: pair.privateKey,
		jwk: {
			kty: exported.kty,
			n: exported.n,
			e: exported.e,
			alg: "RS256",
			use: "sig",
			kid,
		},
	};
}

async function signAccessJwt(email: string, now = T0): Promise<string> {
	const nowSec = Math.floor(now / 1000);
	const headerB64 = toBase64Url(
		JSON.stringify({ alg: "RS256", typ: "JWT", kid: signingKey.kid }),
	);
	const payloadB64 = toBase64Url(
		JSON.stringify({
			aud: TEST_AUD,
			exp: nowSec + 24 * 3600,
			nbf: nowSec - 10,
			email,
			sub: `sub-${email}`,
		}),
	);
	const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		signingKey.privateKey,
		signingInput,
	);
	return `${headerB64}.${payloadB64}.${toBase64Url(new Uint8Array(signature))}`;
}

function accessEnv(): UiEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: "false",
		AUDIT_BODY_RETENTION_DAYS: "30",
		CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		CF_ACCESS_AUD: TEST_AUD,
	};
}

function jwksFetcher(): JwksFetcher {
	const doc = { keys: [signingKey.jwk] };
	return vi.fn(async () => doc);
}

interface AdminSession {
	cookie: string;
	csrfToken: string;
	jwt: string;
	fetcher: JwksFetcher;
}

function extractCsrfToken(htmlText: string): string {
	const match = /name="csrf_token" value="([^"]+)"/.exec(htmlText);
	if (!match?.[1]) {
		throw new Error("Could not find csrf_token in HTML response");
	}
	return match[1];
}

async function openAdminBotSession(
	now = T0,
): Promise<{ session: AdminSession; response: Response; html: string }> {
	const jwt = await signAccessJwt(ADMIN_EMAIL, now);
	const fetcher = jwksFetcher();
	const response = await handleAdminRequest(
		new Request("https://paab.test/admin/adminbot", {
			method: "GET",
			headers: { "Cf-Access-Jwt-Assertion": jwt },
		}),
		accessEnv(),
		now,
		{ fetchJwks: fetcher },
	);
	const setCookie = response.headers.get("Set-Cookie") ?? "";
	const cookie = setCookie.split(";", 1)[0] ?? "";
	const html = await response.text();
	const csrfToken = extractCsrfToken(html);
	return { session: { cookie, csrfToken, jwt, fetcher }, response, html };
}

async function adminGet(
	session: AdminSession,
	path: string,
	now = T0,
): Promise<{ response: Response; html: string }> {
	const response = await handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "GET",
			headers: {
				Cookie: session.cookie,
				"Cf-Access-Jwt-Assertion": session.jwt,
			},
		}),
		accessEnv(),
		now,
		{ fetchJwks: session.fetcher },
	);
	return { response, html: await response.text() };
}

async function adminPost(
	session: AdminSession,
	path: string,
	fields: Record<string, string> = {},
	now = T0,
): Promise<{ response: Response; html: string }> {
	const response = await handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "POST",
			headers: {
				Cookie: session.cookie,
				Origin: "https://paab.test",
				"Cf-Access-Jwt-Assertion": session.jwt,
			},
			body: new URLSearchParams({
				csrf_token: session.csrfToken,
				...fields,
			}),
		}),
		accessEnv(),
		now,
		{ fetchJwks: session.fetcher },
	);
	return { response, html: await response.text() };
}

async function connectAdminMcp(token: string, now = T0): Promise<Client> {
	const client = new Client({ name: "paab-ui-undo", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(ADMIN_MCP_URL), {
		fetch: (input, init) =>
			handleAdminMcpRequest(new Request(input, init), accessEnv(), now),
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	await client.connect(transport);
	return client;
}

async function loadAgent(id: string) {
	const row = await db
		.prepare("SELECT * FROM agents WHERE id = ?")
		.bind(id)
		.first<AgentRow>();
	if (row === null) throw new Error(`Agent not found: ${id}`);
	return agentFromRow(row);
}

beforeAll(async () => {
	signingKey = await generateSigningKey("adminbot-undo-ui-key");
});

beforeEach(async () => {
	db = await createTestDb();
});

describe("/admin/adminbot 1-click Undo UI", () => {
	it("shows admin_bot changes newest first with zero inline scripts, reverts in 1 click, records change_reverted, and blocks double-undo", async () => {
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		const museReg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 20,
			actor: owner,
			now: T0,
		});
		const grokReg = await registerAgent(db, {
			name: "grok",
			dailyQuestionLimit: 15,
			actor: owner,
			now: T0 + 1,
		});
		if (!museReg.ok || !grokReg.ok) throw new Error("register failed");
		const muse = museReg.data.agent;
		const grok = grokReg.data.agent;
		const schedule = await seedCategory(db, { name: "schedule" });

		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: owner,
			now: T0 + 2,
		});
		await designateAdminBot(db, {
			agentId: muse.id,
			actor: owner,
			now: T0 + 3,
		});
		const issued = await issueAdminBotToken(db, {
			agentId: muse.id,
			actor: owner,
			now: T0 + 4,
		});
		if (!issued.ok) throw new Error("token issue failed");

		const mcpClient = await connectAdminMcp(issued.data.token, T0 + 10);
		expect(
			(
				await call(mcpClient, "lower_daily_limit", {
					agent: "grok",
					new_limit: 4,
				})
			).isError,
		).toBe(false);
		expect(
			(
				await call(mcpClient, "revoke_allow_rule", {
					from: "muse",
					to: "grok",
					category: "schedule",
				})
			).isError,
		).toBe(false);
		expect(
			(await call(mcpClient, "suspend_agent", { agent: "grok" })).isError,
		).toBe(false);

		const botChanges = await queryChangeLog(db, { actorType: "admin_bot" });
		expect(botChanges).toHaveLength(3);
		const [suspendChange, revokeChange, lowerChange] = botChanges;
		if (!suspendChange || !revokeChange || !lowerChange) {
			throw new Error("Expected 3 bot changes");
		}

		const { session, html } = await openAdminBotSession(T0 + 20);
		expect(html).toContain("管理者ボットによる変更履歴");
		// Only the single CSP-hashed timestamp formatter script from layout.ts may exist.
		expect(html.match(/<script\b/g)).toHaveLength(1);
		// Owner actions (agent_registered, allow_rule_granted, etc.) must not appear in the bot undo table.
		expect(html).not.toContain("管理者ボット指名");

		const idxSuspend = html.indexOf(
			`/admin/adminbot/changes/${suspendChange.id}/revert`,
		);
		const idxRevoke = html.indexOf(
			`/admin/adminbot/changes/${revokeChange.id}/revert`,
		);
		const idxLower = html.indexOf(
			`/admin/adminbot/changes/${lowerChange.id}/revert`,
		);
		expect(idxSuspend).toBeGreaterThan(-1);
		expect(idxRevoke).toBeGreaterThan(idxSuspend);
		expect(idxLower).toBeGreaterThan(idxRevoke);

		const undoSuspend = await adminPost(
			session,
			`/admin/adminbot/changes/${suspendChange.id}/revert`,
			{},
			T0 + 30,
		);
		expect(undoSuspend.response.status).toBe(200);
		expect(undoSuspend.html).toContain(
			`変更 #${suspendChange.id}（エージェント停止）を元に戻しました`,
		);
		expect(undoSuspend.html).toContain("元に戻しました");
		expect(undoSuspend.html).not.toContain(
			`/admin/adminbot/changes/${suspendChange.id}/revert`,
		);
		expect((await loadAgent(grok.id)).status).toBe("active");

		const doubleUndo = await adminPost(
			session,
			`/admin/adminbot/changes/${suspendChange.id}/revert`,
			{},
			T0 + 31,
		);
		expect(doubleUndo.response.status).toBe(409);
		expect(doubleUndo.html).toContain("すでに元に戻されています");

		const undoRevoke = await adminPost(
			session,
			`/admin/adminbot/changes/${revokeChange.id}/revert`,
			{},
			T0 + 32,
		);
		expect(undoRevoke.response.status).toBe(200);
		expect(
			(
				await checkQuestion(db, {
					fromAgentId: muse.id,
					toAgentName: "grok",
					categoryName: "schedule",
					now: T0 + 33,
				})
			).allowed,
		).toBe(true);

		const undoLower = await adminPost(
			session,
			`/admin/adminbot/changes/${lowerChange.id}/revert`,
			{},
			T0 + 34,
		);
		expect(undoLower.response.status).toBe(200);
		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(15);

		const revertRows = (await queryChangeLog(db)).filter(
			(e) => e.action === "change_reverted",
		);
		expect(revertRows).toHaveLength(3);
		for (const row of revertRows) {
			expect(row.actorType).toBe("owner");
			expect(row.actorId).toBe(ADMIN_EMAIL);
		}

		const rulesPage = await adminGet(session, "/admin/rules", T0 + 35);
		expect(rulesPage.response.status).toBe(200);
		expect(rulesPage.html).toContain("変更取消");
		expect(rulesPage.html).toContain("取消済");
	});

	it("blocks undo with 409 when a newer conflicting change exists, and enforces CSRF and validation", async () => {
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		const museReg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 20,
			actor: owner,
			now: T0,
		});
		const grokReg = await registerAgent(db, {
			name: "grok",
			dailyQuestionLimit: 15,
			actor: owner,
			now: T0 + 1,
		});
		if (!museReg.ok || !grokReg.ok) throw new Error("register failed");
		const muse = museReg.data.agent;
		const grok = grokReg.data.agent;

		await designateAdminBot(db, {
			agentId: muse.id,
			actor: owner,
			now: T0 + 2,
		});
		const issued = await issueAdminBotToken(db, {
			agentId: muse.id,
			actor: owner,
			now: T0 + 3,
		});
		if (!issued.ok) throw new Error("token issue failed");

		const mcpClient = await connectAdminMcp(issued.data.token, T0 + 10);
		await call(mcpClient, "suspend_agent", { agent: "grok" });
		const [botSuspend] = await queryChangeLog(db, { actorType: "admin_bot" });
		if (!botSuspend) throw new Error("Expected bot suspend change");

		await resumeAgent(db, { agentId: grok.id, actor: owner, now: T0 + 11 });
		await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 30,
			actor: owner,
			now: T0 + 12,
		});

		const { session } = await openAdminBotSession(T0 + 20);
		const conflict = await adminPost(
			session,
			`/admin/adminbot/changes/${botSuspend.id}/revert`,
			{},
			T0 + 21,
		);
		expect(conflict.response.status).toBe(409);
		expect(conflict.html).toContain("新しい変更があるため元に戻せません");
		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(30);
		expect((await loadAgent(grok.id)).status).toBe("active");

		expect(
			(
				await adminPost(
					session,
					"/admin/adminbot/changes/abc/revert",
					{},
					T0 + 22,
				)
			).response.status,
		).toBe(400);
		expect(
			(
				await adminPost(
					session,
					"/admin/adminbot/changes/999999/revert",
					{},
					T0 + 23,
				)
			).response.status,
		).toBe(404);
		expect(
			(
				await adminPost(
					session,
					`/admin/adminbot/changes/${grokReg.changeId}/revert`,
					{},
					T0 + 24,
				)
			).response.status,
		).toBe(400);

		const noCsrf = await handleAdminRequest(
			new Request(
				`https://paab.test/admin/adminbot/changes/${botSuspend.id}/revert`,
				{
					method: "POST",
					headers: {
						Cookie: session.cookie,
						Origin: "https://paab.test",
						"Cf-Access-Jwt-Assertion": session.jwt,
					},
					body: new URLSearchParams(),
				},
			),
			accessEnv(),
			T0 + 25,
			{ fetchJwks: session.fetcher },
		);
		expect(noCsrf.status).toBe(403);
	});

	it("paginates past 100 admin_bot changes and filters by unreverted=1 and target_type", async () => {
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		const museReg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 20,
			actor: owner,
			now: T0,
		});
		const grokReg = await registerAgent(db, {
			name: "grok",
			dailyQuestionLimit: 200,
			actor: owner,
			now: T0 + 1,
		});
		if (!museReg.ok || !grokReg.ok) throw new Error("register failed");
		const muse = museReg.data.agent;
		const grok = grokReg.data.agent;
		const schedule = await seedCategory(db, { name: "schedule" });

		// First bot change (#1): grant an allow rule (will be pushed past the first 100 entries).
		const oldestGrant = await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: { actorType: "admin_bot", actorId: muse.id },
			now: T0 + 10,
		});
		if (!oldestGrant.ok) throw new Error("oldest grant failed");

		// Flood 104 more admin_bot changes (105 total), with 90 already reverted and 14 still un-reverted.
		const flood: D1PreparedStatement[] = [];
		for (let i = 0; i < 104; i += 1) {
			flood.push(
				insertChangeLogEntry(db, {
					occurredAt: T0 + 20 + i,
					actorType: "admin_bot",
					actorId: muse.id,
					approverId: null,
					action: "agent_updated",
					targetType: "agent",
					targetId: grok.id,
					beforeJson: JSON.stringify({
						id: grok.id,
						name: "grok",
						dailyQuestionLimit: 200 - i,
					}),
					afterJson: JSON.stringify({
						id: grok.id,
						name: "grok",
						dailyQuestionLimit: 199 - i,
					}),
					revertedAt: i >= 14 ? T0 + 500 : null,
				}),
			);
		}
		await db.batch(flood);

		const { session, html: page1Html } = await openAdminBotSession(T0 + 1000);
		expect(page1Html).toContain("未取消の変更: <strong>15</strong> 件");
		expect(page1Html).toContain("表示中: 100 件");
		expect(page1Html).toContain("古い変更を表示");
		expect(page1Html).not.toContain(
			`/admin/adminbot/changes/${oldestGrant.changeId}/revert`,
		);

		// Follow the before_id link to page 2 and undo the 105th oldest change in 1 click.
		const nextLinkMatch =
			/href="(\/admin\/adminbot\?[^"]*before_id=\d+[^"]*)"/.exec(page1Html);
		expect(nextLinkMatch?.[1]).toBeTruthy();
		const nextHref = (nextLinkMatch?.[1] ?? "").replaceAll("&amp;", "&");
		const page2 = await adminGet(session, nextHref, T0 + 1001);
		expect(page2.response.status).toBe(200);
		expect(page2.html).toContain("表示中: 5 件");
		expect(page2.html).toContain("最新の変更へ");
		expect(page2.html).toContain(
			`/admin/adminbot/changes/${oldestGrant.changeId}/revert`,
		);

		// Filtering by unreverted=1 surfaces all 15 un-reverted entries (including the oldest grant) on page 1.
		const unrevertedPage = await adminGet(
			session,
			"/admin/adminbot?unreverted=1",
			T0 + 1002,
		);
		expect(unrevertedPage.response.status).toBe(200);
		expect(unrevertedPage.html).toContain("表示中: 15 件");
		expect(unrevertedPage.html).toContain(
			`/admin/adminbot/changes/${oldestGrant.changeId}/revert`,
		);

		// Filtering by target_type=allow_rule isolates the allow_rule entry.
		const ruleOnlyPage = await adminGet(
			session,
			"/admin/adminbot?target_type=allow_rule",
			T0 + 1003,
		);
		expect(ruleOnlyPage.response.status).toBe(200);
		expect(ruleOnlyPage.html).toContain("表示中: 1 件");
		expect(ruleOnlyPage.html).toContain(
			`/admin/adminbot/changes/${oldestGrant.changeId}/revert`,
		);

		// Invalid query parameters return 400 with flash error.
		expect(
			(
				await adminGet(
					session,
					"/admin/adminbot?target_type=invalid",
					T0 + 1004,
				)
			).response.status,
		).toBe(400);
		expect(
			(await adminGet(session, "/admin/adminbot?before_id=abc", T0 + 1005))
				.response.status,
		).toBe(400);

		// Revert that 105th oldest allow_rule_granted change in 1 click.
		const undoOldest = await adminPost(
			session,
			`/admin/adminbot/changes/${oldestGrant.changeId}/revert`,
			{ filter_unreverted: "1" },
			T0 + 1006,
		);
		expect(undoOldest.response.status).toBe(200);
		expect(undoOldest.html).toContain(
			`変更 #${oldestGrant.changeId}（許可ルール追加）を元に戻しました`,
		);
		expect(
			(
				await checkQuestion(db, {
					fromAgentId: muse.id,
					toAgentName: "grok",
					categoryName: "schedule",
					now: T0 + 1007,
				})
			).allowed,
		).toBe(false);
	});

	it("renders 1-click cascade rollback for stacked changes and 1-click undo for description_rejected", async () => {
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		const museReg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 20,
			actor: owner,
			now: T0,
		});
		const grokReg = await registerAgent(db, {
			name: "grok",
			dailyQuestionLimit: 30,
			actor: owner,
			now: T0 + 1,
		});
		if (!museReg.ok || !grokReg.ok) throw new Error("register failed");
		const muse = museReg.data.agent;
		const grok = grokReg.data.agent;
		const botActor = { actorType: "admin_bot" as const, actorId: muse.id };

		const step1 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 20,
			actor: botActor,
			now: T0 + 10,
		});
		const step2 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 10,
			actor: botActor,
			now: T0 + 11,
		});
		const step3 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 5,
			actor: botActor,
			now: T0 + 12,
		});
		const sub = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "restorable rejected bio",
			now: T0 + 13,
		});
		if (
			!step1.ok ||
			step1.changeId === null ||
			!step2.ok ||
			step2.changeId === null ||
			!step3.ok ||
			step3.changeId === null ||
			!sub.ok
		) {
			throw new Error("setup failed");
		}
		const rejected = await rejectPendingDescription(db, {
			agentId: grok.id,
			expectedSubmissionId: sub.data.pending.submissionId,
			actor: botActor,
			now: T0 + 14,
		});
		if (!rejected.ok) throw new Error("reject failed");

		const { session, html } = await openAdminBotSession(T0 + 20);
		expect(html).toContain("以降もまとめて元に戻す（3件）");
		expect(html).toContain('name="cascade" value="1"');
		expect(html).toContain(
			`/admin/adminbot/changes/${rejected.changeId}/revert`,
		);
		expect(html).not.toContain("取消不可");

		// 1-click cascade revert from step1 restores limit to 30 and reverts all 3 limit changes.
		const cascadeRes = await adminPost(
			session,
			`/admin/adminbot/changes/${step1.changeId}/revert`,
			{ cascade: "1" },
			T0 + 21,
		);
		expect(cascadeRes.response.status).toBe(200);
		expect(cascadeRes.html).toContain("3 件の変更をまとめて元に戻しました");
		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(30);

		// 1-click undo of description_rejected restores the pending description row.
		const restoreDescRes = await adminPost(
			session,
			`/admin/adminbot/changes/${rejected.changeId}/revert`,
			{},
			T0 + 22,
		);
		expect(restoreDescRes.response.status).toBe(200);
		expect(restoreDescRes.html).toContain(
			`変更 #${rejected.changeId}（説明文却下）を元に戻しました`,
		);
		const pending = await listPendingDescriptions(db);
		expect(pending).toHaveLength(1);
		expect(pending[0]?.pendingDescription).toBe("restorable rejected bio");

		// When an owner change intervenes on the same field, the UI marks the older bot change as conflicted and POST cascade=1 returns 409.
		const botChange = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 12,
			actor: botActor,
			now: T0 + 30,
		});
		await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 25,
			actor: owner,
			now: T0 + 31,
		});
		if (!botChange.ok || botChange.changeId === null) {
			throw new Error("botChange failed");
		}
		const afterOwnerPage = await adminGet(session, "/admin/adminbot", T0 + 32);
		expect(afterOwnerPage.html).toContain("取消不可（競合あり）");
		const blockedCascade = await adminPost(
			session,
			`/admin/adminbot/changes/${botChange.changeId}/revert`,
			{ cascade: "1" },
			T0 + 33,
		);
		expect(blockedCascade.response.status).toBe(409);
		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(25);
	});
});
