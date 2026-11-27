import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { approvePendingDescription } from "../../src/adminbot";
import { queryAuditLog } from "../../src/audit";
import {
	type AgentRow,
	agentFromRow,
	type PendingDescriptionRow,
	pendingDescriptionFromRow,
} from "../../src/db";
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

beforeEach(async () => {
	world = await createMcpWorld();
});

const recordingEnv: McpEnv = {
	DB: env.DB,
	AUDIT_RECORD_BODIES: "true",
	AUDIT_BODY_RETENTION_DAYS: "30",
};

async function loadPending(agentId: string) {
	const row = await world.db
		.prepare("SELECT * FROM pending_descriptions WHERE agent_id = ?")
		.bind(agentId)
		.first<PendingDescriptionRow>();
	return row ? pendingDescriptionFromRow(row) : null;
}

async function loadAgentDescription(agentId: string): Promise<string> {
	const row = await world.db
		.prepare("SELECT * FROM agents WHERE id = ?")
		.bind(agentId)
		.first<AgentRow>();
	if (row === null) throw new Error("Agent not found");
	return agentFromRow(row).description;
}

describe("submit_description tool", () => {
	it("stores a pending draft without changing list_agents, supports resubmission, and publishes only after approval", async () => {
		const alice = await connect(world.alice.token, { now: T0 });
		const bob1 = await connect(world.bob.token, { now: T0 + 10 });

		const beforeList = await call(alice, "list_agents");
		expect(beforeList.isError).toBe(false);
		expect(beforeList.text).toContain("bob knows");

		const firstSubmit = await call(bob1, "submit_description", {
			description: "Draft v1:\tmanages personal schedule\nand reminders.",
		});
		expect(firstSubmit.isError).toBe(false);
		expect(unreadCount(firstSubmit.text)).toBe(0);
		expect(withoutFooter(firstSubmit.text)).toContain("status: submitted");
		expect(withoutFooter(firstSubmit.text)).toContain(
			"remains visible in list_agents until approved",
		);

		expect(await loadPending(world.bob.agent.id)).toEqual({
			agentId: world.bob.agent.id,
			description: "Draft v1:\tmanages personal schedule\nand reminders.",
			submittedAt: T0 + 10,
		});
		expect(await loadAgentDescription(world.bob.agent.id)).toBe("bob knows");

		// Other agents still see only the previously approved description.
		const duringPending = await call(alice, "list_agents");
		expect(duringPending.text).toContain("bob knows");
		expect(duringPending.text).not.toContain("Draft v1");

		// Resubmitting replaces the previous pending draft (with NFC normalization).
		const bob2 = await connect(world.bob.token, { now: T0 + 25 });
		const secondSubmit = await call(bob2, "submit_description", {
			description: "か\u3099担当の予定エージェント",
		});
		expect(secondSubmit.isError).toBe(false);
		expect(await loadPending(world.bob.agent.id)).toEqual({
			agentId: world.bob.agent.id,
			description: "が担当の予定エージェント",
			submittedAt: T0 + 25,
		});
		expect(await loadAgentDescription(world.bob.agent.id)).toBe("bob knows");

		// Still only one pending row for bob.
		const count = await world.db
			.prepare(
				"SELECT COUNT(*) AS n FROM pending_descriptions WHERE agent_id = ?",
			)
			.bind(world.bob.agent.id)
			.first<{ n: number }>();
		expect(count?.n).toBe(1);

		// Once approved, list_agents returns the newly approved description.
		const approved = await approvePendingDescription(world.db, {
			agentId: world.bob.agent.id,
			actor: { actorType: "owner", actorId: "owner@example.com" },
			now: T0 + 30,
		});
		expect(approved.ok).toBe(true);

		const afterApproval = await call(alice, "list_agents");
		expect(afterApproval.isError).toBe(false);
		expect(afterApproval.text).toContain("が担当の予定エージェント");
		expect(afterApproval.text).not.toContain("bob knows");
	});

	it("records description_submitted in audit_log respecting AUDIT_RECORD_BODIES", async () => {
		const bobDefault = await connect(world.bob.token, { now: T0 + 1 });
		const res1 = await call(bobDefault, "submit_description", {
			description: "Secret draft without body recording",
		});
		expect(res1.isError).toBe(false);

		const bobRecording = await connect(world.bob.token, {
			now: T0 + 2,
			env: recordingEnv,
		});
		const res2 = await call(bobRecording, "submit_description", {
			description: "Draft with body recording enabled",
		});
		expect(res2.isError).toBe(false);

		const entries = await queryAuditLog(world.db, { includeBody: true });
		const submitted = entries.filter(
			(e) => e.eventType === "description_submitted",
		);
		expect(submitted).toHaveLength(2);
		expect(submitted[0]).toMatchObject({
			occurredAt: T0 + 1,
			eventType: "description_submitted",
			fromAgentId: world.bob.agent.id,
			toAgentId: null,
			categoryId: null,
			outcome: "ok",
			reasonCode: null,
			messageId: null,
			body: null,
		});
		expect(submitted[1]).toMatchObject({
			occurredAt: T0 + 2,
			eventType: "description_submitted",
			fromAgentId: world.bob.agent.id,
			outcome: "ok",
			body: "Draft with body recording enabled",
		});
	});

	it("rejects descriptions exceeding DESCRIPTION_MAX_LENGTH or containing forbidden control characters immediately", async () => {
		const bob = await connect(world.bob.token, { now: T0, env: recordingEnv });

		const tooLong = await call(bob, "submit_description", {
			description: "a".repeat(DESCRIPTION_MAX_LENGTH + 1),
		});
		expect(tooLong.isError).toBe(true);
		expect(unreadCount(tooLong.text)).toBe(0);
		expect(tooLong.text).toContain(`${DESCRIPTION_MAX_LENGTH}`);

		for (const bad of [
			"null\u0000byte",
			"bell\u0007char",
			"cr\rnewline",
			"del\u007fchar",
		]) {
			const rejected = await call(bob, "submit_description", {
				description: bad,
			});
			expect(rejected.isError).toBe(true);
		}

		expect(await loadPending(world.bob.agent.id)).toBeNull();
		const audit = await queryAuditLog(world.db);
		expect(
			audit.filter((e) => e.eventType === "description_submitted"),
		).toHaveLength(0);

		// Exactly DESCRIPTION_MAX_LENGTH characters succeeds.
		const exact = await call(bob, "submit_description", {
			description: "あ".repeat(DESCRIPTION_MAX_LENGTH),
		});
		expect(exact.isError).toBe(false);
		expect((await loadPending(world.bob.agent.id))?.description).toHaveLength(
			DESCRIPTION_MAX_LENGTH,
		);
	});
});
