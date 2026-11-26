import { beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../../scripts/lib/sql";
import { issueParticipantToken } from "../../scripts/lib/token";
import { authenticate, hashToken, issueToken } from "../../src/auth";
import { type ChangeLogRow, changeLogEntryFromRow } from "../../src/db";
import type { Agent } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { HOUR_MS, seedAgent, T0 } from "../helpers/fixtures";
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

describe("issueParticipantToken", () => {
	it("issues a token that authenticates as the named agent and records change_log", async () => {
		const { token, revokedPrevious } = await issueParticipantToken(
			d1Client(db),
			"muse",
			T0,
		);
		expect(revokedPrevious).toBe(false);

		const auth = await authenticate(db, `Bearer ${token}`, "participant");
		expect(auth).toMatchObject({ ok: true, agent: { id: muse.id } });

		const logs = await changeLogs();
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			occurredAt: T0,
			actorType: "owner",
			actorId: "cli",
			action: "token_issued",
			targetType: "token",
			beforeJson: null,
		});
		expect(JSON.parse(logs[0]?.afterJson ?? "null")).toEqual({
			id: logs[0]?.targetId,
			purpose: "participant",
			agentId: muse.id,
		});
	});

	it("stores no plaintext or hash in change_log", async () => {
		const { token } = await issueParticipantToken(d1Client(db), "muse", T0);
		const tokenHash = await hashToken(token);
		const stored = JSON.stringify(await snapshot(db));
		const logged = JSON.stringify(await changeLogs());
		expect(stored).not.toContain(token);
		expect(stored).not.toContain(token.slice("paab_".length));
		expect(logged).not.toContain(token);
		expect(logged).not.toContain(token.slice("paab_".length));
		expect(logged).not.toContain(tokenHash);
	});

	it("revokes the previous participant token on reissue and records beforeJson", async () => {
		const first = await issueParticipantToken(d1Client(db), "muse", T0);
		const second = await issueParticipantToken(
			d1Client(db),
			"muse",
			T0 + HOUR_MS,
		);
		expect(second.revokedPrevious).toBe(true);

		expect(
			await authenticate(db, `Bearer ${first.token}`, "participant"),
		).toMatchObject({ ok: false, reason: "token_revoked" });
		expect(
			await authenticate(db, `Bearer ${second.token}`, "participant"),
		).toMatchObject({ ok: true });

		const logs = await changeLogs();
		expect(logs).toHaveLength(2);
		expect(JSON.parse(logs[1]?.beforeJson ?? "null")).toEqual({
			id: logs[0]?.targetId,
			purpose: "participant",
			agentId: muse.id,
		});
		expect(JSON.parse(logs[1]?.afterJson ?? "null")).toEqual({
			id: logs[1]?.targetId,
			purpose: "participant",
			agentId: muse.id,
		});
	});

	it("leaves tokens of other purposes valid", async () => {
		const unread = await issueToken(db, {
			agentId: muse.id,
			purpose: "unread_count",
			now: T0,
		});
		await issueParticipantToken(d1Client(db), "muse", T0 + HOUR_MS);
		expect(
			await authenticate(db, `Bearer ${unread.token}`, "unread_count"),
		).toMatchObject({ ok: true });
	});

	it("refuses an unknown agent without writing anything", async () => {
		const before = await snapshot(db);
		const error = await issueParticipantToken(d1Client(db), "ghost", T0).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(CliError);
		expect((error as Error).message).toContain("「ghost」は登録されていません");
		expect(await snapshot(db)).toEqual(before);
		expect(await changeLogs()).toHaveLength(0);
	});
});
