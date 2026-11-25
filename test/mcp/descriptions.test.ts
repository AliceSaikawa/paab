import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { queryAuditLog } from "../../src/audit";
import type { McpEnv } from "../../src/mcp/config";
import { DESCRIPTION_MAX_LENGTH } from "../../src/policy";
import { T0 } from "../helpers/fixtures";
import {
	call,
	connect,
	createMcpWorld,
	type McpWorld,
	unreadCount,
	withoutFooter,
} from "./support";

let world: McpWorld;

const recordingBodies: McpEnv = {
	DB: env.DB,
	AUDIT_RECORD_BODIES: "true",
	AUDIT_BODY_RETENTION_DAYS: "30",
};

beforeEach(async () => {
	world = await createMcpWorld();
});

async function pendingRowFor(agentId: string) {
	return world.db
		.prepare(
			"SELECT agent_id, description, submitted_at FROM pending_descriptions WHERE agent_id = ?",
		)
		.bind(agentId)
		.first<{
			agent_id: string;
			description: string;
			submitted_at: number;
		}>();
}

describe("submit_description", () => {
	it("stores a normalized draft without changing list_agents and overwrites on resubmission", async () => {
		const alice = await connect(world.alice.token, { now: T0 });
		const bobFirst = await connect(world.bob.token, { now: T0 + 100 });

		const nfdDraft = "Cafe\u0301 schedule\n\tweekdays only";
		const firstRes = await call(bobFirst, "submit_description", {
			description: nfdDraft,
		});
		expect(firstRes.isError).toBe(false);
		expect(unreadCount(firstRes.text)).toBe(0);
		expect(withoutFooter(firstRes.text)).toContain("submitted for approval");

		const aliceList1 = await call(alice, "list_agents");
		expect(aliceList1.text).toContain("bob knows");
		expect(aliceList1.text).not.toContain("weekdays only");

		expect(await pendingRowFor(world.bob.agent.id)).toEqual({
			agent_id: world.bob.agent.id,
			description: nfdDraft.normalize("NFC"),
			submitted_at: T0 + 100,
		});

		const bobSecond = await connect(world.bob.token, { now: T0 + 250 });
		const secondRes = await call(bobSecond, "submit_description", {
			description: "Updated calendar & travel helper",
		});
		expect(secondRes.isError).toBe(false);

		const allPending = await world.db
			.prepare("SELECT * FROM pending_descriptions WHERE agent_id = ?")
			.bind(world.bob.agent.id)
			.all();
		expect(allPending.results).toHaveLength(1);
		expect(await pendingRowFor(world.bob.agent.id)).toEqual({
			agent_id: world.bob.agent.id,
			description: "Updated calendar & travel helper",
			submitted_at: T0 + 250,
		});

		const aliceList2 = await call(alice, "list_agents");
		expect(aliceList2.text).toContain("bob knows");
		expect(aliceList2.text).not.toContain("Updated calendar & travel helper");
	});

	it(`accepts ${DESCRIPTION_MAX_LENGTH} UTF-16 code units, allows newline/tab, and rejects over-limit or control characters without touching DB`, async () => {
		const bob = await connect(world.bob.token, {
			env: recordingBodies,
			now: T0 + 50,
		});

		const maxValid = "a".repeat(DESCRIPTION_MAX_LENGTH);
		const validRes = await call(bob, "submit_description", {
			description: maxValid,
		});
		expect(validRes.isError).toBe(false);
		expect((await pendingRowFor(world.bob.agent.id))?.description).toBe(
			maxValid,
		);

		const auditBeforeInvalid = (await queryAuditLog(world.db)).length;

		const tooLong = "a".repeat(DESCRIPTION_MAX_LENGTH + 1);
		const tooLongRes = await call(bob, "submit_description", {
			description: tooLong,
		});
		expect(tooLongRes.isError).toBe(true);
		expect(unreadCount(tooLongRes.text)).toBe(0);

		const astralTooLong = "😀".repeat(DESCRIPTION_MAX_LENGTH / 2 + 1);
		const astralRes = await call(bob, "submit_description", {
			description: astralTooLong,
		});
		expect(astralRes.isError).toBe(true);

		for (const badChar of ["\x00", "\r", "\x1f", "\x7f", "\u0085"]) {
			const controlRes = await call(bob, "submit_description", {
				description: `hello${badChar}world`,
			});
			expect(controlRes.isError).toBe(true);
		}

		expect(await pendingRowFor(world.bob.agent.id)).toEqual({
			agent_id: world.bob.agent.id,
			description: maxValid,
			submitted_at: T0 + 50,
		});
		expect(await queryAuditLog(world.db)).toHaveLength(auditBeforeInvalid);
	});

	it("records description_submitted in audit_log with body omitted by default and saved when recording is enabled", async () => {
		const bobDefault = await connect(world.bob.token, { now: T0 + 10 });
		await call(bobDefault, "submit_description", {
			description: "Draft without body logging",
		});

		const defaultLogs = await queryAuditLog(world.db, { includeBody: true });
		expect(defaultLogs).toHaveLength(1);
		expect(defaultLogs[0]).toMatchObject({
			occurredAt: T0 + 10,
			eventType: "description_submitted",
			fromAgentId: world.bob.agent.id,
			toAgentId: null,
			categoryId: null,
			outcome: "ok",
			reasonCode: null,
			body: null,
		});

		const bobRecording = await connect(world.bob.token, {
			env: recordingBodies,
			now: T0 + 20,
		});
		await call(bobRecording, "submit_description", {
			description: "Draft with\u0301 body logging",
		});

		const recordingLogs = await queryAuditLog(world.db, { includeBody: true });
		expect(recordingLogs).toHaveLength(2);
		expect(recordingLogs[1]).toMatchObject({
			occurredAt: T0 + 20,
			eventType: "description_submitted",
			fromAgentId: world.bob.agent.id,
			outcome: "ok",
			body: "Draft with\u0301 body logging".normalize("NFC"),
		});
	});
});
