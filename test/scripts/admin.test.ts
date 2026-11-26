import { beforeEach, describe, expect, it } from "vitest";
import { revokeAgentTokens, setAgentStatus } from "../../scripts/lib/admin";
import { CliError } from "../../scripts/lib/sql";
import { issueParticipantToken } from "../../scripts/lib/token";
import { authenticate } from "../../src/auth";
import { type ChangeLogRow, changeLogEntryFromRow } from "../../src/db";
import { handleMcpRequest } from "../../src/mcp";
import type { Agent } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { seedAgent, T0 } from "../helpers/fixtures";
import { d1Client, snapshot } from "./support";

let db: D1Database;
let muse: Agent;

beforeEach(async () => {
	db = await createTestDb();
	muse = await seedAgent(db, { name: "muse" });
});

async function changeLogs() {
	const { results } = await db
		.prepare("SELECT * FROM change_log ORDER BY id")
		.all<ChangeLogRow>();
	return results.map(changeLogEntryFromRow);
}

describe("setAgentStatus", () => {
	it("suspends and resumes the named agent and records change_log entries", async () => {
		expect(await setAgentStatus(d1Client(db), "muse", "suspended", T0)).toBe(
			true,
		);
		const suspended = await db
			.prepare("SELECT status FROM agents WHERE id = ?")
			.bind(muse.id)
			.first<{ status: string }>();
		expect(suspended?.status).toBe("suspended");

		expect(await setAgentStatus(d1Client(db), "muse", "active", T0 + 1)).toBe(
			true,
		);
		const resumed = await db
			.prepare("SELECT status FROM agents WHERE id = ?")
			.bind(muse.id)
			.first<{ status: string }>();
		expect(resumed?.status).toBe("active");

		const logs = await changeLogs();
		expect(logs).toHaveLength(2);
		expect(logs[0]).toMatchObject({
			occurredAt: T0,
			actorType: "owner",
			actorId: "cli",
			action: "agent_suspended",
			targetType: "agent",
			targetId: muse.id,
		});
		expect(JSON.parse(logs[0]?.beforeJson ?? "null")).toMatchObject({
			status: "active",
		});
		expect(JSON.parse(logs[0]?.afterJson ?? "null")).toMatchObject({
			status: "suspended",
		});
		expect(logs[1]).toMatchObject({
			occurredAt: T0 + 1,
			actorType: "owner",
			actorId: "cli",
			action: "agent_resumed",
			targetType: "agent",
			targetId: muse.id,
		});
	});

	it("reports no change when the agent already has the status", async () => {
		const before = await snapshot(db);
		expect(await setAgentStatus(d1Client(db), "muse", "active", T0)).toBe(
			false,
		);
		expect(await snapshot(db)).toEqual(before);
		expect(await changeLogs()).toHaveLength(0);
	});

	it("refuses an unknown agent without touching the database", async () => {
		const before = await snapshot(db);
		await expect(
			setAgentStatus(d1Client(db), "ghost", "suspended", T0),
		).rejects.toBeInstanceOf(CliError);
		expect(await snapshot(db)).toEqual(before);
		expect(await changeLogs()).toHaveLength(0);
	});

	it("causes /mcp requests to return 403 while suspended and succeed once resumed", async () => {
		const { token } = await issueParticipantToken(d1Client(db), "muse", T0);
		const mcpEnv = {
			DB: db,
			AUDIT_RECORD_BODIES: "false",
			AUDIT_BODY_RETENTION_DAYS: "30",
		};
		const post = () =>
			new Request("https://paab.test/mcp", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
				}),
			});

		await setAgentStatus(d1Client(db), "muse", "suspended");
		const suspendedRes = await handleMcpRequest(post(), mcpEnv, T0 + 1);
		expect(suspendedRes.status).toBe(403);

		await setAgentStatus(d1Client(db), "muse", "active");
		const resumedRes = await handleMcpRequest(post(), mcpEnv, T0 + 2);
		expect(resumedRes.status).toBe(200);
	});
});

describe("revokeAgentTokens", () => {
	it("revokes every valid token of the agent and logs the change", async () => {
		const { token } = await issueParticipantToken(d1Client(db), "muse", T0);
		await db
			.prepare("INSERT INTO tokens VALUES ('t2', ?, 'hash2', 'admin', ?, NULL)")
			.bind(muse.id, T0)
			.run();

		expect(await revokeAgentTokens(d1Client(db), "muse", T0 + 1)).toBe(2);

		const valid = await db
			.prepare("SELECT count(*) AS n FROM tokens WHERE revoked_at IS NULL")
			.first<{ n: number }>();
		expect(valid?.n).toBe(0);
		const auth = await authenticate(db, `Bearer ${token}`, "participant");
		expect(auth.ok).toBe(false);

		const logs = await changeLogs();
		expect(logs).toHaveLength(2);
		expect(logs[1]).toMatchObject({
			occurredAt: T0 + 1,
			actorType: "owner",
			actorId: "cli",
			action: "token_revoked",
			targetType: "token",
			targetId: muse.id,
			afterJson: null,
		});
		expect(logs[1]?.beforeJson).not.toContain(token);
		expect(logs[1]?.beforeJson).not.toContain("hash2");
	});

	it("leaves the tokens of other agents alone", async () => {
		const grok = await seedAgent(db, { name: "grok" });
		const other = await issueParticipantToken(d1Client(db), "grok", T0);
		await issueParticipantToken(d1Client(db), "muse", T0);

		expect(await revokeAgentTokens(d1Client(db), "muse", T0 + 1)).toBe(1);
		const auth = await authenticate(db, `Bearer ${other.token}`, "participant");
		expect(auth).toMatchObject({ ok: true, agent: { id: grok.id } });
	});

	it("reports zero when no token is valid", async () => {
		const before = await snapshot(db);
		expect(await revokeAgentTokens(d1Client(db), "muse", T0)).toBe(0);
		expect(await snapshot(db)).toEqual(before);
		expect(await changeLogs()).toHaveLength(0);
	});

	it("refuses an unknown agent without touching the database", async () => {
		const before = await snapshot(db);
		await expect(
			revokeAgentTokens(d1Client(db), "ghost", T0),
		).rejects.toBeInstanceOf(CliError);
		expect(await snapshot(db)).toEqual(before);
		expect(await changeLogs()).toHaveLength(0);
	});
});
