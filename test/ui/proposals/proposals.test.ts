import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ChangeActor,
	deleteCategory,
	listCategoriesWithUsage,
	queryChangeLog,
	registerAgent,
	suspendAgent,
} from "../../../src/admin";
import {
	createProposal,
	designateAdminBot,
	handleAdminMcpRequest,
	issueAdminBotToken,
	listProposals,
	PROPOSAL_TTL_MS,
} from "../../../src/adminbot";
import { issueToken } from "../../../src/auth";
import { handleMcpRequest, runScheduledMaintenance } from "../../../src/mcp";
import type { Agent } from "../../../src/types";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { seedCategory, T0 } from "../../helpers/fixtures";
import { call, connect, withoutFooter } from "../../mcp/support";

const TEAM_DOMAIN = "paab-team.cloudflareaccess.com";
const TEST_AUD = "proposals-ui-aud";
const OWNER_EMAIL = "owner-proposals@example.com";
const OWNER: ChangeActor = { actorType: "owner", actorId: OWNER_EMAIL };
const ADMIN_MCP_URL = "https://paab.test/mcp/admin";

interface SigningKeyPair {
	kid: string;
	privateKey: CryptoKey;
	jwk: JwkKey;
}

let signingKey: SigningKeyPair;
let db: D1Database;
let bot: Agent;
let alice: Agent;
let bob: Agent;
let adminToken: string;

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

async function openProposalsSession(
	email = OWNER_EMAIL,
	now = T0,
): Promise<{ session: AdminSession; response: Response; html: string }> {
	const jwt = await signAccessJwt(email, now);
	const fetcher = jwksFetcher();
	const response = await handleAdminRequest(
		new Request("https://paab.test/admin/proposals", {
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
	return {
		session: { cookie, csrfToken, jwt, fetcher },
		response,
		html,
	};
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
	const body = new URLSearchParams({
		csrf_token: session.csrfToken,
		...fields,
	});
	const response = await handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "POST",
			headers: {
				Cookie: session.cookie,
				Origin: "https://paab.test",
				"Cf-Access-Jwt-Assertion": session.jwt,
			},
			body,
		}),
		accessEnv(),
		now,
		{ fetchJwks: session.fetcher },
	);
	return { response, html: await response.text() };
}

async function connectAdminMcp(token: string, now = T0): Promise<Client> {
	const client = new Client({ name: "paab-ui-proposals", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(ADMIN_MCP_URL), {
		fetch: (input, init) =>
			handleAdminMcpRequest(new Request(input, init), accessEnv(), now),
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	await client.connect(transport);
	return client;
}

async function sha256HeaderValue(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	let binary = "";
	for (const byte of new Uint8Array(digest)) {
		binary += String.fromCharCode(byte);
	}
	return `sha256-${btoa(binary)}`;
}

beforeAll(async () => {
	signingKey = await generateSigningKey("proposals-ui-key");
});

beforeEach(async () => {
	db = await createTestDb();
	const rBot = await registerAgent(db, {
		name: "admin-bot",
		dailyQuestionLimit: 10,
		actor: OWNER,
		now: T0,
	});
	const rAlice = await registerAgent(db, {
		name: "alice",
		dailyQuestionLimit: 1,
		actor: OWNER,
		now: T0,
	});
	const rBob = await registerAgent(db, {
		name: "bob",
		dailyQuestionLimit: 10,
		actor: OWNER,
		now: T0,
	});
	if (!rBot.ok || !rAlice.ok || !rBob.ok) {
		throw new Error("Expected agents");
	}
	bot = rBot.data.agent;
	alice = rAlice.data.agent;
	bob = rBob.data.agent;
	await seedCategory(db, { name: "予定" });

	await designateAdminBot(db, { agentId: bot.id, actor: OWNER, now: T0 });
	const issued = await issueAdminBotToken(db, {
		agentId: bot.id,
		actor: OWNER,
		now: T0,
	});
	if (!issued.ok) throw new Error("Expected admin token");
	adminToken = issued.data.token;
});

describe("/admin/proposals UI", () => {
	it("is fail-closed via SELF.fetch when Access is unconfigured", async () => {
		const res = await SELF.fetch("https://paab.test/admin/proposals");
		expect(res.status).toBe(503);
	});

	it("renders mechanical summary independent of bot reason, escapes XSS, and adds zero inline scripts", async () => {
		const maliciousReason =
			'<script>alert("xss")</script>\n実は「管理者」カテゴリを作成し、上限を999にします';
		const created = await createProposal(db, {
			botAgentId: bot.id,
			request: { kind: "create_category", name: "健康" },
			reason: maliciousReason,
			now: T0 + 1,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const { session, response, html } = await openProposalsSession(
			OWNER_EMAIL,
			T0 + 2,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(html).toContain('href="/admin/proposals" aria-current="page"');
		expect(html).not.toContain("この画面はまだ実装されていません");

		expect(html).toContain("ブリッジが生成した変更内容");
		expect(html).toContain("管理者ボットが書いた理由");
		expect(html).toContain("カテゴリを追加: 「健康」");

		expect(html).toContain(
			"&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
		);
		expect(html).not.toContain('<script>alert("xss")</script>');

		const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
		expect(scripts).toHaveLength(1);
		const csp = response.headers.get("Content-Security-Policy") ?? "";
		const expectedHash = await sha256HeaderValue(scripts[0]?.[1] ?? "");
		expect(csp).toContain(`script-src '${expectedHash}'`);

		expect(html).toContain(
			`action="/admin/proposals/${encodeURIComponent(created.data.proposal.id)}/approve"`,
		);
		expect(html).toContain(
			`action="/admin/proposals/${encodeURIComponent(created.data.proposal.id)}/reject"`,
		);

		const rejected = await adminPost(
			session,
			`/admin/proposals/${encodeURIComponent(created.data.proposal.id)}/reject`,
			{},
			T0 + 5,
		);
		expect(rejected.response.status).toBe(200);
		expect(rejected.html).toContain("提案を却下しました");
		expect(rejected.html).toContain("却下");
		expect(
			(await listCategoriesWithUsage(db)).map((c) => c.category.name),
		).toEqual(["予定"]);
	});

	it("approves proposals in UI, reflects changes in participant MCP, and records admin_bot + approver_id in change_log", async () => {
		await suspendAgent(db, { agentId: bob.id, actor: OWNER, now: T0 });
		const alicePart = await issueToken(db, {
			agentId: alice.id,
			purpose: "participant",
			now: T0,
		});
		const bobPart = await issueToken(db, {
			agentId: bob.id,
			purpose: "participant",
			now: T0,
		});

		const adminMcp = await connectAdminMcp(adminToken, T0 + 10);
		await call(adminMcp, "propose_allow_rule", {
			from: "alice",
			to: "bob",
			category: "予定",
			reason: "alice needs bob's schedule",
		});
		await call(adminMcp, "propose_daily_limit_raise", {
			agent: "alice",
			new_limit: 5,
			reason: "1/day is too small",
		});
		await call(adminMcp, "propose_resume_agent", {
			agent: "bob",
			reason: "bob is ready",
		});
		await call(adminMcp, "propose_category", {
			name: "趣味",
			reason: "new topic",
		});

		const aliceClient = await connect(alicePart.token, { now: T0 + 20 });
		expect(withoutFooter((await call(aliceClient, "list_agents")).text)).toBe(
			"no agents you may ask",
		);
		const bobBlockedRes = await handleMcpRequest(
			new Request("https://paab.test/mcp", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${bobPart.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
			accessEnv(),
			T0 + 20,
		);
		expect(bobBlockedRes.status).toBe(403);

		const proposals = await listProposals(db, { status: "pending" });
		expect(proposals).toHaveLength(4);
		const byKind = new Map(proposals.map((p) => [p.kind, p]));

		const { session } = await openProposalsSession(OWNER_EMAIL, T0 + 30);

		for (const kind of [
			"grant_allow_rule",
			"raise_daily_limit",
			"resume_agent",
			"create_category",
		] as const) {
			const target = byKind.get(kind);
			if (!target) throw new Error(`Missing ${kind}`);
			const res = await adminPost(
				session,
				`/admin/proposals/${encodeURIComponent(target.id)}/approve`,
				{},
				T0 + 40,
			);
			expect(res.response.status).toBe(200);
			expect(res.html).toContain("提案を承認して反映しました");
		}

		const listAfter = withoutFooter(
			(await call(aliceClient, "list_agents")).text,
		);
		expect(listAfter).toContain("name: bob");
		expect(listAfter).toContain("categories: 予定");

		await call(aliceClient, "ask", {
			to: "bob",
			category: "予定",
			question: "質問1",
		});
		await call(aliceClient, "ask", {
			to: "bob",
			category: "予定",
			question: "質問2",
		});

		const bobClient = await connect(bobPart.token, { now: T0 + 50 });
		const bobInbox = withoutFooter((await call(bobClient, "check_inbox")).text);
		expect(bobInbox).toContain("質問1");
		expect(bobInbox).toContain("質問2");

		const botLogs = await queryChangeLog(db, { actorType: "admin_bot" });
		expect(botLogs).toHaveLength(4);
		for (const entry of botLogs) {
			expect(entry.actorType).toBe("admin_bot");
			expect(entry.actorId).toBe(bot.id);
			expect(entry.approverId).toBe(OWNER_EMAIL);
		}

		const rulesView = await adminGet(session, "/admin/rules", T0 + 60);
		expect(rulesView.response.status).toBe(200);
		expect(rulesView.html).toContain(`管理者ボット: ${bot.id}`);
		expect(rulesView.html).toContain(`承認: ${OWNER_EMAIL}`);
	});

	it("returns 409/404 for expired, missing, and stale-precondition approvals and enforces CSRF", async () => {
		const tempCat = await seedCategory(db, { name: "削除対象" });
		const staleRule = await createProposal(db, {
			botAgentId: bot.id,
			request: {
				kind: "grant_allow_rule",
				fromAgentName: "alice",
				toAgentName: "bob",
				categoryName: "削除対象",
			},
			reason: "will become stale",
			now: T0 + 1,
		});
		const expiring = await createProposal(db, {
			botAgentId: bot.id,
			request: { kind: "create_category", name: "期限切れカテゴリ" },
			reason: "will expire",
			now: T0 + 2,
		});
		if (!staleRule.ok || !expiring.ok) throw new Error("Expected proposals");

		await deleteCategory(db, {
			categoryId: tempCat.id,
			actor: OWNER,
			now: T0 + 3,
		});

		const { session } = await openProposalsSession(OWNER_EMAIL, T0 + 10);

		const staleRes = await adminPost(
			session,
			`/admin/proposals/${encodeURIComponent(staleRule.data.proposal.id)}/approve`,
			{},
			T0 + 10,
		);
		expect(staleRes.response.status).toBe(404);
		expect(staleRes.html).toContain(
			"カテゴリが削除されているため承認できません",
		);

		const missingRes = await adminPost(
			session,
			"/admin/proposals/does-not-exist/approve",
			{},
			T0 + 10,
		);
		expect(missingRes.response.status).toBe(404);

		const afterExpiryNow = T0 + 2 + PROPOSAL_TTL_MS + 1;
		await runScheduledMaintenance(env, T0 + 2 + PROPOSAL_TTL_MS);
		const laterSession: AdminSession = {
			...session,
			jwt: await signAccessJwt(OWNER_EMAIL, afterExpiryNow),
		};
		const expiredView = await adminGet(
			laterSession,
			"/admin/proposals",
			afterExpiryNow,
		);
		expect(expiredView.html).toContain("期限切れ（却下扱い）");
		expect(expiredView.html).toContain(
			"未処理の提案は14日で期限切れ（却下扱い）になります",
		);
		expect(expiredView.html).toContain("カテゴリを追加: 「期限切れカテゴリ」");

		const expiredApproveRes = await adminPost(
			laterSession,
			`/admin/proposals/${encodeURIComponent(expiring.data.proposal.id)}/approve`,
			{},
			afterExpiryNow + 1,
		);
		expect(expiredApproveRes.response.status).toBe(409);
		expect(expiredApproveRes.html).toContain("有効期限（14日）");

		const noCsrf = await handleAdminRequest(
			new Request(
				`https://paab.test/admin/proposals/${encodeURIComponent(staleRule.data.proposal.id)}/reject`,
				{
					method: "POST",
					headers: {
						Cookie: session.cookie,
						Origin: "https://paab.test",
						"Cf-Access-Jwt-Assertion": session.jwt,
					},
				},
			),
			accessEnv(),
			T0 + 10,
			{ fetchJwks: session.fetcher },
		);
		expect(noCsrf.status).toBe(403);
	});

	it("renders overdue proposals as 期限切れ（却下扱い） in recent history and excludes them from pending before cron runs", async () => {
		const created = await createProposal(db, {
			botAgentId: bot.id,
			request: { kind: "create_category", name: "未スイープ期限切れ" },
			reason: "overdue before cron",
			now: T0,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const afterExpiryNow = T0 + PROPOSAL_TTL_MS;
		const jwt = await signAccessJwt(OWNER_EMAIL, afterExpiryNow);
		const response = await handleAdminRequest(
			new Request("https://paab.test/admin/proposals", {
				method: "GET",
				headers: { "Cf-Access-Jwt-Assertion": jwt },
			}),
			accessEnv(),
			afterExpiryNow,
			{ fetchJwks: jwksFetcher() },
		);
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain(
			"未処理の提案は14日で期限切れ（却下扱い）になります",
		);
		expect(html).toContain("現在、承認待ちの提案はありません。");
		expect(html).toContain(
			'<span class="badge badge-dev">期限切れ（却下扱い）</span>',
		);
		expect(html).toContain("カテゴリを追加: 「未スイープ期限切れ」");
		expect(html).toContain("期限: ");
		expect(html).not.toContain(
			`/admin/proposals/${encodeURIComponent(created.data.proposal.id)}/approve`,
		);
	});
});
