import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	listAllowRulesGrouped,
	queryChangeLog,
	registerAgent,
} from "../../../src/admin";
import {
	designateAdminBot,
	getAdminBotConfig,
	handleAdminMcpRequest,
	issueAdminBotToken,
	SUPERADMIN_PERMANENT,
	setAdminBotReadBodies,
	setAdminBotSuperadmin,
} from "../../../src/adminbot";
import type { ChangeLogEntry } from "../../../src/types";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { describeChangeBeforeAfter } from "../../../src/ui/rules/render";
import { createTestDb } from "../../helpers/db";
import { DAY_MS, HOUR_MS, seedCategory, T0 } from "../../helpers/fixtures";
import { call } from "../../mcp/support";

const TEAM_DOMAIN = "paab-team.cloudflareaccess.com";
const TEST_AUD = "adminbot-superadmin-ui-aud";
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
			exp: nowSec + 365 * 24 * 3600,
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
		AUDIT_RECORD_BODIES: "true",
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
	fields: Record<string, string>,
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
	const client = new Client({
		name: "paab-ui-superadmin",
		version: "0.0.0",
	});
	const transport = new StreamableHTTPClientTransport(new URL(ADMIN_MCP_URL), {
		fetch: (input, init) =>
			handleAdminMcpRequest(new Request(input, init), accessEnv(), now),
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	await client.connect(transport);
	return client;
}

beforeAll(async () => {
	signingKey = await generateSigningKey("adminbot-superadmin-ui-key");
});

beforeEach(async () => {
	db = await createTestDb();
});

describe("/admin/adminbot superadmin switch UI", () => {
	it("defaults OFF, shows duration presets (7d default + permanent), risk summary, remaining time, expired state, OFF toggle, change_log, and 1-click undo", async () => {
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		const museReg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 10,
			actor: owner,
			now: T0,
		});
		const grokReg = await registerAgent(db, {
			name: "grok",
			dailyQuestionLimit: 10,
			actor: owner,
			now: T0 + 1,
		});
		if (!museReg.ok || !grokReg.ok) {
			throw new Error("Expected agents to register");
		}
		const museId = museReg.data.agent.id;
		await seedCategory(db, { name: "schedule" });

		// Before designation: superadmin form is hidden and POST returns 409.
		const before = await openAdminBotSession(T0 + 2);
		expect(before.response.status).toBe(200);
		expect(before.html).not.toContain(
			'action="/admin/adminbot/permissions/superadmin"',
		);
		const unsetPost = await adminPost(
			before.session,
			"/admin/adminbot/permissions/superadmin",
			{ duration: "7" },
			T0 + 3,
		);
		expect(unsetPost.response.status).toBe(409);

		// Designate muse and issue admin token.
		await designateAdminBot(db, {
			agentId: museId,
			actor: owner,
			now: T0 + 4,
		});
		const issued = await issueAdminBotToken(db, {
			agentId: museId,
			actor: owner,
			now: T0 + 5,
		});
		if (!issued.ok) throw new Error("Expected admin token");

		// Default OFF state with presets (7 selected by default + permanent) and §5.3 risk summary.
		const pageOff = await adminGet(before.session, "/admin/adminbot", T0 + 6);
		expect(pageOff.response.status).toBe(200);
		expect(pageOff.html).toContain("最高管理者権限");
		expect(pageOff.html).toContain("把握しているリスク");
		expect(pageOff.html).toContain("プロンプトインジェクション");
		expect(pageOff.html).toContain("全カテゴリの開示許可");
		expect(pageOff.html).toContain(
			'action="/admin/adminbot/permissions/superadmin"',
		);
		expect(pageOff.html).toContain('<option value="1"');
		expect(pageOff.html).toContain('<option value="3"');
		expect(pageOff.html).toContain('value="7" selected');
		expect(pageOff.html).toContain('<option value="14"');
		expect(pageOff.html).toContain('<option value="30"');
		expect(pageOff.html).toContain('<option value="permanent">無期限</option>');
		expect(pageOff.html).not.toContain("最高管理者権限をオフにする");

		// Enable 7 days -> immediate (no confirm since read_bodies is OFF).
		const enabled7d = await adminPost(
			before.session,
			"/admin/adminbot/permissions/superadmin",
			{ duration: "7" },
			T0 + 10,
		);
		expect(enabled7d.response.status).toBe(200);
		expect(enabled7d.html).toContain("最高管理者権限を 7 日間オンにしました");
		expect(enabled7d.html).toContain(
			'<span class="badge badge-dev">有効</span>',
		);
		expect(enabled7d.html).toContain("残り 7日 0時間");
		expect(enabled7d.html).toContain("最高管理者権限をオフにする");
		expect((await getAdminBotConfig(db)).superadminUntil).toBe(
			T0 + 10 + 7 * DAY_MS,
		);

		// Remaining time updates cleanly after 3 days 12 hours.
		const midPage = await adminGet(
			before.session,
			"/admin/adminbot",
			T0 + 10 + 3 * DAY_MS + 12 * HOUR_MS,
		);
		expect(midPage.html).toContain("残り 3日 12時間");

		// Execute a loosening tool via /mcp/admin and revert it in 1 click from /admin/adminbot.
		const client = await connectAdminMcp(issued.data.token, T0 + 10 + HOUR_MS);
		const grantRes = await call(client, "propose_allow_rule", {
			from: "muse",
			to: "grok",
			category: "schedule",
			reason: "ui integration test",
		});
		expect(grantRes.isError).toBe(false);
		expect(grantRes.text).toContain("mode: executed_immediately");
		expect(await listAllowRulesGrouped(db)).toHaveLength(1);

		const match = /^change_id: (\d+)$/m.exec(grantRes.text);
		expect(match?.[1]).toBeTruthy();
		const revertRes = await adminPost(
			before.session,
			`/admin/adminbot/changes/${match?.[1]}/revert`,
			{},
			T0 + 10 + 2 * HOUR_MS,
		);
		expect(revertRes.response.status).toBe(200);
		expect(revertRes.html).toContain("元に戻しました");
		expect(await listAllowRulesGrouped(db)).toEqual([]);

		// /admin/rules change_log shows 最高管理者=有効.
		const rulesAfterTimed = await adminGet(
			before.session,
			"/admin/rules",
			T0 + 10 + 3 * HOUR_MS,
		);
		expect(rulesAfterTimed.html).toContain("管理者ボット権限変更");
		expect(rulesAfterTimed.html).toContain("最高管理者=有効");

		// Expired state (now >= superadminUntil) shown immediately without cron.
		const expiredPage = await adminGet(
			before.session,
			"/admin/adminbot",
			T0 + 10 + 7 * DAY_MS,
		);
		expect(expiredPage.response.status).toBe(200);
		expect(expiredPage.html).toContain("期限切れ（オフ）");
		expect(expiredPage.html).not.toContain("最高管理者権限をオフにする");

		// Enable permanent -> shows 有効（無期限） and change_log renders 最高管理者=無期限.
		const permRes = await adminPost(
			before.session,
			"/admin/adminbot/permissions/superadmin",
			{ duration: "permanent" },
			T0 + 10 + 8 * DAY_MS,
		);
		expect(permRes.response.status).toBe(200);
		expect(permRes.html).toContain("最高管理者権限を無期限でオンにしました");
		expect(permRes.html).toContain("有効（無期限）");
		expect(permRes.html).toContain("最高管理者権限をオフにする");
		expect((await getAdminBotConfig(db)).superadminUntil).toBe(
			SUPERADMIN_PERMANENT,
		);

		const rulesAfterPerm = await adminGet(
			before.session,
			"/admin/rules",
			T0 + 10 + 8 * DAY_MS + 1,
		);
		expect(rulesAfterPerm.html).toContain("最高管理者=無期限");

		// Turn OFF via inline form.
		const offRes = await adminPost(
			before.session,
			"/admin/adminbot/permissions/superadmin",
			{ duration: "off" },
			T0 + 10 + 9 * DAY_MS,
		);
		expect(offRes.response.status).toBe(200);
		expect(offRes.html).toContain("最高管理者権限をオフにしました");
		expect(offRes.html).not.toContain("最高管理者権限をオフにする");
		expect((await getAdminBotConfig(db)).superadminUntil).toBeNull();
	});

	it("requires 1-step confirmation ONLY when enabling the second optional permission while the first is active", async () => {
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		const reg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 10,
			actor: owner,
			now: T0,
		});
		if (!reg.ok) throw new Error("Expected agent");
		const museId = reg.data.agent.id;
		await designateAdminBot(db, { agentId: museId, actor: owner, now: T0 + 1 });

		const { session } = await openAdminBotSession(T0 + 2);

		// 1. Single switch ON (read_bodies alone): immediate, no confirmation screen.
		const rbFirst = await adminPost(
			session,
			"/admin/adminbot/permissions/read-bodies",
			{ enabled: "1" },
			T0 + 10,
		);
		expect(rbFirst.response.status).toBe(200);
		expect(rbFirst.html).toContain("本文閲覧をオンにしました");
		expect(rbFirst.html).not.toContain("同時有効化の確認");
		expect((await getAdminBotConfig(db)).readBodies).toBe(true);

		// 2. Enabling superadmin while read_bodies is ON -> confirmation screen WITHOUT mutating DB.
		const logsBeforeConfirm1 = await queryChangeLog(db);
		const saNeedsConfirm = await adminPost(
			session,
			"/admin/adminbot/permissions/superadmin",
			{ duration: "7" },
			T0 + 20,
		);
		expect(saNeedsConfirm.response.status).toBe(200);
		expect(saNeedsConfirm.html).toContain("同時有効化の確認");
		expect(saNeedsConfirm.html).toContain(
			'action="/admin/adminbot/permissions/superadmin"',
		);
		expect(saNeedsConfirm.html).toContain('name="duration" value="7"');
		expect(saNeedsConfirm.html).toContain('name="confirm_both" value="1"');
		expect(saNeedsConfirm.html).toContain('href="/admin/adminbot"');
		expect((await getAdminBotConfig(db)).superadminUntil).toBeNull();
		expect(await queryChangeLog(db)).toHaveLength(logsBeforeConfirm1.length);

		// 3. Submitting confirm_both=1 succeeds and enables superadmin.
		const saConfirmed = await adminPost(
			session,
			"/admin/adminbot/permissions/superadmin",
			{ duration: "7", confirm_both: "1" },
			T0 + 30,
		);
		expect(saConfirmed.response.status).toBe(200);
		expect(saConfirmed.html).toContain("最高管理者権限を 7 日間オンにしました");
		expect((await getAdminBotConfig(db)).superadminUntil).toBe(
			T0 + 30 + 7 * DAY_MS,
		);

		// 4. Extending already-active superadmin while read_bodies is ON -> immediate (NO confirm).
		const saExtended = await adminPost(
			session,
			"/admin/adminbot/permissions/superadmin",
			{ duration: "14" },
			T0 + 30 + HOUR_MS,
		);
		expect(saExtended.response.status).toBe(200);
		expect(saExtended.html).toContain("最高管理者権限を 14 日間オンにしました");
		expect(saExtended.html).not.toContain("同時有効化の確認");
		expect((await getAdminBotConfig(db)).superadminUntil).toBe(
			T0 + 30 + HOUR_MS + 14 * DAY_MS,
		);

		// 5. Turn read_bodies OFF; now superadmin is active and read_bodies is OFF.
		await setAdminBotReadBodies(db, {
			enabled: false,
			actor: owner,
			now: T0 + 30 + 2 * HOUR_MS,
		});
		const logsBeforeConfirm2 = await queryChangeLog(db);

		// Enabling read_bodies while superadmin is ACTIVE -> confirmation screen WITHOUT mutating DB.
		const rbNeedsConfirm = await adminPost(
			session,
			"/admin/adminbot/permissions/read-bodies",
			{ enabled: "1" },
			T0 + 30 + 3 * HOUR_MS,
		);
		expect(rbNeedsConfirm.response.status).toBe(200);
		expect(rbNeedsConfirm.html).toContain("同時有効化の確認");
		expect(rbNeedsConfirm.html).toContain(
			'action="/admin/adminbot/permissions/read-bodies"',
		);
		expect(rbNeedsConfirm.html).toContain('name="enabled" value="1"');
		expect(rbNeedsConfirm.html).toContain('name="confirm_both" value="1"');
		expect(rbNeedsConfirm.html).toContain('href="/admin/adminbot"');
		expect((await getAdminBotConfig(db)).readBodies).toBe(false);
		expect(await queryChangeLog(db)).toHaveLength(logsBeforeConfirm2.length);

		// Confirming read_bodies with confirm_both=1 succeeds.
		const rbConfirmed = await adminPost(
			session,
			"/admin/adminbot/permissions/read-bodies",
			{ enabled: "1", confirm_both: "1" },
			T0 + 30 + 4 * HOUR_MS,
		);
		expect(rbConfirmed.response.status).toBe(200);
		expect(rbConfirmed.html).toContain("本文閲覧をオンにしました");
		expect((await getAdminBotConfig(db)).readBodies).toBe(true);

		// 6. Enabling read_bodies while superadmin is EXPIRED -> immediate (NO confirm).
		await setAdminBotReadBodies(db, {
			enabled: false,
			actor: owner,
			now: T0 + 30 + 5 * HOUR_MS,
		});
		const afterExpiry = T0 + 30 + HOUR_MS + 14 * DAY_MS;
		const rbWhileExpired = await adminPost(
			session,
			"/admin/adminbot/permissions/read-bodies",
			{ enabled: "1" },
			afterExpiry,
		);
		expect(rbWhileExpired.response.status).toBe(200);
		expect(rbWhileExpired.html).toContain("本文閲覧をオンにしました");
		expect(rbWhileExpired.html).not.toContain("同時有効化の確認");
		expect((await getAdminBotConfig(db)).readBodies).toBe(true);

		// 7. Re-enabling EXPIRED superadmin while read_bodies is ON -> DOES trigger confirm screen.
		const saReEnableAfterExpiry = await adminPost(
			session,
			"/admin/adminbot/permissions/superadmin",
			{ duration: "permanent" },
			afterExpiry + 10,
		);
		expect(saReEnableAfterExpiry.response.status).toBe(200);
		expect(saReEnableAfterExpiry.html).toContain("同時有効化の確認");
		expect(saReEnableAfterExpiry.html).toContain(
			'name="duration" value="permanent"',
		);
		expect((await getAdminBotConfig(db)).superadminUntil).toBe(afterExpiry);

		// 8. Also check direction B when superadmin is permanent.
		await setAdminBotReadBodies(db, {
			enabled: false,
			actor: owner,
			now: afterExpiry + 20,
		});
		await setAdminBotSuperadmin(db, {
			mode: "permanent",
			actor: owner,
			now: afterExpiry + 30,
		});
		const rbWhilePerm = await adminPost(
			session,
			"/admin/adminbot/permissions/read-bodies",
			{ enabled: "1" },
			afterExpiry + 40,
		);
		expect(rbWhilePerm.response.status).toBe(200);
		expect(rbWhilePerm.html).toContain("同時有効化の確認");
		expect(rbWhilePerm.html).toContain("最高管理者権限（無期限）");
		expect((await getAdminBotConfig(db)).readBodies).toBe(false);
	});

	it("rejects invalid duration values with 400 and enforces CSRF on superadmin POST", async () => {
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		const reg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 10,
			actor: owner,
			now: T0,
		});
		if (!reg.ok) throw new Error("Expected agent");
		await designateAdminBot(db, {
			agentId: reg.data.agent.id,
			actor: owner,
			now: T0 + 1,
		});

		const { session } = await openAdminBotSession(T0 + 2);
		const logsBefore = await queryChangeLog(db);

		for (const badFields of [
			{} as Record<string, string>,
			{ duration: "" },
			{ duration: "0" },
			{ duration: "-7" },
			{ duration: "07" },
			{ duration: "7.5" },
			{ duration: "366" },
			{ duration: "forever" },
		]) {
			const res = await adminPost(
				session,
				"/admin/adminbot/permissions/superadmin",
				badFields,
				T0 + 3,
			);
			expect(res.response.status).toBe(400);
			expect(res.html).toContain("最高管理者権限の有効期間の指定が不正です");
		}
		expect((await getAdminBotConfig(db)).superadminUntil).toBeNull();
		expect(await queryChangeLog(db)).toHaveLength(logsBefore.length);

		const noCsrf = await handleAdminRequest(
			new Request("https://paab.test/admin/adminbot/permissions/superadmin", {
				method: "POST",
				headers: {
					Cookie: session.cookie,
					Origin: "https://paab.test",
					"Cf-Access-Jwt-Assertion": session.jwt,
				},
				body: new URLSearchParams({ duration: "7" }),
			}),
			accessEnv(),
			T0 + 4,
			{ fetchJwks: session.fetcher },
		);
		expect(noCsrf.status).toBe(403);
		expect((await getAdminBotConfig(db)).superadminUntil).toBeNull();
	});

	it("renders superadmin status in change_log relative to entry.occurredAt", () => {
		const names = {
			agents: new Map([["agent-1", "muse"]]),
			categories: new Map<string, string>(),
		};
		const baseEntry: Omit<
			ChangeLogEntry,
			"occurredAt" | "action" | "beforeJson" | "afterJson"
		> = {
			id: 1,
			actorType: "owner",
			actorId: ADMIN_EMAIL,
			approverId: null,
			targetType: "admin_bot",
			targetId: "agent-1",
			revertedAt: null,
		};

		const expiredToActive: ChangeLogEntry = {
			...baseEntry,
			occurredAt: T0 + 10 * DAY_MS,
			action: "admin_bot_switches_updated",
			beforeJson: JSON.stringify({
				agentId: "agent-1",
				readBodies: false,
				superadminUntil: T0 + 7 * DAY_MS,
				updatedAt: T0,
			}),
			afterJson: JSON.stringify({
				agentId: "agent-1",
				readBodies: false,
				superadminUntil: T0 + 17 * DAY_MS,
				updatedAt: T0 + 10 * DAY_MS,
			}),
		};
		expect(describeChangeBeforeAfter(expiredToActive, names)).toBe(
			"変更前: muse（最高管理者=期限切れ） / 変更後: muse（最高管理者=有効）",
		);

		const exactBoundaryToPermanent: ChangeLogEntry = {
			...baseEntry,
			occurredAt: T0 + 7 * DAY_MS,
			action: "admin_bot_switches_updated",
			beforeJson: JSON.stringify({
				agentId: "agent-1",
				readBodies: true,
				superadminUntil: T0 + 7 * DAY_MS,
				updatedAt: T0,
			}),
			afterJson: JSON.stringify({
				agentId: "agent-1",
				readBodies: true,
				superadminUntil: SUPERADMIN_PERMANENT,
				updatedAt: T0 + 7 * DAY_MS,
			}),
		};
		expect(describeChangeBeforeAfter(exactBoundaryToPermanent, names)).toBe(
			"変更前: muse（本文閲覧=ON・最高管理者=期限切れ） / 変更後: muse（本文閲覧=ON・最高管理者=無期限）",
		);
	});
});
