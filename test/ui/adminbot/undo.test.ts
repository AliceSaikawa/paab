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
	approveProposal,
	createProposal,
	designateAdminBot,
	handleAdminMcpRequest,
	issueAdminBotToken,
} from "../../../src/adminbot";
import { listPendingDescriptions } from "../../../src/adminbot/descriptions";
import { issueToken } from "../../../src/auth";
import { type AgentRow, agentFromRow } from "../../../src/db";
import { checkQuestion } from "../../../src/policy";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { seedCategory, T0 } from "../../helpers/fixtures";
import { call, connect } from "../../mcp/support";

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

	it("supports 1-click undo of description_approved and description_rejected, preserves approved description on lower_daily_limit undo, shows approverId, and renders agent names & readable description snapshots on /admin/rules", async () => {
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		const museReg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 20,
			actor: owner,
			now: T0,
		});
		const grokReg = await registerAgent(db, {
			name: "grok",
			description: "",
			dailyQuestionLimit: 15,
			actor: owner,
			now: T0 + 1,
		});
		const bobReg = await registerAgent(db, {
			name: "bob",
			description: "bob v1",
			dailyQuestionLimit: 10,
			actor: owner,
			now: T0 + 2,
		});
		if (!museReg.ok || !grokReg.ok || !bobReg.ok) {
			throw new Error("register failed");
		}
		const muse = museReg.data.agent;
		const grok = grokReg.data.agent;
		const bob = bobReg.data.agent;

		await designateAdminBot(db, {
			agentId: muse.id,
			actor: owner,
			now: T0 + 3,
		});
		const adminTok = await issueAdminBotToken(db, {
			agentId: muse.id,
			actor: owner,
			now: T0 + 4,
		});
		if (!adminTok.ok) throw new Error("admin token failed");

		const grokPartTok = await issueToken(db, {
			agentId: grok.id,
			purpose: "participant",
			now: T0 + 5,
		});
		const bobPartTok = await issueToken(db, {
			agentId: bob.id,
			purpose: "participant",
			now: T0 + 6,
		});

		const grokMcp = await connect(grokPartTok.token, { now: T0 + 10 });
		const bobMcp = await connect(bobPartTok.token, { now: T0 + 11 });
		const adminMcp = await connectAdminMcp(adminTok.data.token, T0 + 12);

		// 1. Bot lowers grok's limit, then grok submits description and bot approves it.
		expect(
			(
				await call(adminMcp, "lower_daily_limit", {
					agent: "grok",
					new_limit: 5,
				})
			).isError,
		).toBe(false);
		expect(
			(
				await call(grokMcp, "submit_description", {
					description: "grok approved bio",
				})
			).isError,
		).toBe(false);
		expect(
			(
				await call(adminMcp, "review_description", {
					agent: "grok",
					action: "approve",
				})
			).isError,
		).toBe(false);

		// 2. Bob submits a draft and bot rejects it.
		expect(
			(
				await call(bobMcp, "submit_description", {
					description: "bob rejected draft",
				})
			).isError,
		).toBe(false);
		expect(
			(
				await call(adminMcp, "review_description", {
					agent: "bob",
					action: "reject",
				})
			).isError,
		).toBe(false);

		// 3. Create and approve a proposal so an admin_bot change with approverId exists.
		const proposal = await createProposal(db, {
			botAgentId: muse.id,
			request: { kind: "create_category", name: "travel" },
			reason: "needed for travel questions",
			now: T0 + 15,
		});
		if (!proposal.ok) throw new Error("createProposal failed");
		const approvedProposal = await approveProposal(db, {
			proposalId: proposal.data.proposal.id,
			approverEmail: ADMIN_EMAIL,
			now: T0 + 16,
		});
		if (!approvedProposal.ok) throw new Error("approveProposal failed");

		const botChanges = await queryChangeLog(db, { actorType: "admin_bot" });
		const lowerChange = botChanges.find((e) => e.action === "agent_updated");
		const approveChange = botChanges.find(
			(e) => e.action === "description_approved",
		);
		const rejectChange = botChanges.find(
			(e) => e.action === "description_rejected",
		);
		const proposalChange = botChanges.find(
			(e) => e.action === "category_created",
		);
		if (!lowerChange || !approveChange || !rejectChange || !proposalChange) {
			throw new Error("Expected all 4 bot change_log entries");
		}

		// Verify /admin/adminbot renders Undo buttons for description actions, approverId on proposal, and zero extra scripts.
		const { session, html } = await openAdminBotSession(T0 + 20);
		expect(html.match(/<script\b/g)).toHaveLength(1);
		expect(html).toContain(
			`/admin/adminbot/changes/${approveChange.id}/revert`,
		);
		expect(html).toContain(`/admin/adminbot/changes/${rejectChange.id}/revert`);
		expect(html).toContain("説明文承認");
		expect(html).toContain("説明文却下");
		expect(html).toContain(`（承認: ${ADMIN_EMAIL}）`);
		// Only the single approved proposal row carries approverId; autonomous rows must not.
		expect(html.match(new RegExp(`承認: ${ADMIN_EMAIL}`, "g"))).toHaveLength(1);

		// Undo lower_daily_limit AFTER description_approved -> restores limit to 15 without clobbering description!
		const undoLower = await adminPost(
			session,
			`/admin/adminbot/changes/${lowerChange.id}/revert`,
			{},
			T0 + 21,
		);
		expect(undoLower.response.status).toBe(200);
		const grokAfterLowerUndo = await loadAgent(grok.id);
		expect(grokAfterLowerUndo.dailyQuestionLimit).toBe(15);
		expect(grokAfterLowerUndo.description).toBe("grok approved bio");

		// Undo description_approved -> restores prior empty description "".
		const undoApprove = await adminPost(
			session,
			`/admin/adminbot/changes/${approveChange.id}/revert`,
			{},
			T0 + 22,
		);
		expect(undoApprove.response.status).toBe(200);
		expect(undoApprove.html).toContain(
			`変更 #${approveChange.id}（説明文承認）を元に戻しました`,
		);
		expect((await loadAgent(grok.id)).description).toBe("");

		// Undo description_rejected -> restores bob's draft in pending_descriptions with original submittedAt.
		const undoReject = await adminPost(
			session,
			`/admin/adminbot/changes/${rejectChange.id}/revert`,
			{},
			T0 + 23,
		);
		expect(undoReject.response.status).toBe(200);
		expect(undoReject.html).toContain(
			`変更 #${rejectChange.id}（説明文却下）を元に戻しました`,
		);
		const restoredPending = await listPendingDescriptions(db);
		expect(restoredPending).toHaveLength(1);
		expect(restoredPending[0]).toMatchObject({
			agentId: bob.id,
			pendingDescription: "bob rejected draft",
			submittedAt: T0 + 11,
		});

		// Re-reject bob's draft and have bob submit a new draft -> undo must return 409 conflict.
		expect(
			(
				await call(adminMcp, "review_description", {
					agent: "bob",
					action: "reject",
				})
			).isError,
		).toBe(false);
		const [secondReject] = (
			await queryChangeLog(db, { actorType: "admin_bot" })
		).filter((e) => e.action === "description_rejected");
		if (!secondReject) throw new Error("Expected second description_rejected");
		expect(
			(
				await call(bobMcp, "submit_description", {
					description: "bob newer draft",
				})
			).isError,
		).toBe(false);
		const conflictRejectUndo = await adminPost(
			session,
			`/admin/adminbot/changes/${secondReject.id}/revert`,
			{},
			T0 + 24,
		);
		expect(conflictRejectUndo.response.status).toBe(409);

		// Verify /admin/rules renders admin_bot actor name (not raw UUID) and human-readable reverted description snapshots.
		const rulesPage = await adminGet(session, "/admin/rules", T0 + 30);
		expect(rulesPage.response.status).toBe(200);
		const historySection =
			rulesPage.html.split("変更履歴（change_log）")[1] ?? "";
		expect(historySection).toContain("管理者ボット: muse");
		expect(historySection).not.toContain(`管理者ボット: ${muse.id}`);
		expect(historySection).toContain(
			"変更前: grok approved bio / 変更後: （空）",
		);
		expect(historySection).toContain(
			"変更前: なし / 変更後: bob rejected draft",
		);
		expect(historySection).not.toContain("&quot;agentId&quot;");
	});
});
