import { beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../../scripts/lib/sql";
import { issueParticipantToken } from "../../scripts/lib/token";
import { authenticate, issueToken } from "../../src/auth";
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

describe("issueParticipantToken", () => {
	it("issues a token that authenticates as the named agent", async () => {
		const { token, revokedPrevious } = await issueParticipantToken(
			d1Client(db),
			"muse",
			T0,
		);
		expect(revokedPrevious).toBe(false);

		const auth = await authenticate(db, `Bearer ${token}`, "participant");
		expect(auth).toMatchObject({ ok: true, agent: { id: muse.id } });
	});

	it("stores no plaintext", async () => {
		const { token } = await issueParticipantToken(d1Client(db), "muse", T0);
		const stored = JSON.stringify(await snapshot(db));
		expect(stored).not.toContain(token);
		expect(stored).not.toContain(token.slice("paab_".length));
	});

	it("revokes the previous participant token on reissue", async () => {
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
	});
});
