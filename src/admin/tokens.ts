import { createToken } from "../auth";
import { insertToken, oneOf } from "../db";
import { TOKEN_PURPOSES } from "../types";
import type {
	AdminResult,
	IssueAgentTokenInput,
	IssuedAgentToken,
	RevokeAgentTokensInput,
	RevokeAgentTokensResult,
	TokenAuditMetadata,
} from "./types";
import {
	fail,
	runWithChangeLog,
	validateContext,
	validateId,
	validateTokenPurpose,
} from "./validate";

interface ActiveTokenMetaRow {
	id: string;
	agent_id: string;
	purpose: string;
}

function toTokenMetadata(row: ActiveTokenMetaRow): TokenAuditMetadata {
	return {
		id: row.id,
		purpose: oneOf(TOKEN_PURPOSES, row.purpose, "tokens.purpose"),
		agentId: row.agent_id,
	};
}

export async function issueAgentToken(
	db: D1Database,
	input: IssueAgentTokenInput,
): Promise<AdminResult<IssuedAgentToken>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const purpose = validateTokenPurpose(input.purpose);
	if (!purpose.ok) return purpose;

	const [agentResult, prevResult] = await db.batch([
		db.prepare("SELECT id FROM agents WHERE id = ?").bind(agentId.value),
		db
			.prepare(
				`SELECT id, agent_id, purpose FROM tokens
				WHERE agent_id = ? AND purpose = ? AND revoked_at IS NULL`,
			)
			.bind(agentId.value, purpose.value),
	]);
	if ((agentResult?.results.length ?? 0) === 0) {
		return fail("not_found", "指定されたエージェントが見つかりません");
	}
	const prevRow = (prevResult?.results[0] ?? null) as ActiveTokenMetaRow | null;

	const created = await createToken({
		agentId: agentId.value,
		purpose: purpose.value,
		now: ctx.value.now,
	});
	const afterMeta: TokenAuditMetadata = {
		id: created.record.id,
		purpose: created.record.purpose,
		agentId: created.record.agentId,
	};
	const beforeMeta = prevRow !== null ? toTokenMetadata(prevRow) : null;

	const changeId = await runWithChangeLog(
		db,
		[
			db
				.prepare(
					`UPDATE tokens SET revoked_at = ?
					WHERE agent_id = ? AND purpose = ? AND revoked_at IS NULL`,
				)
				.bind(ctx.value.now, agentId.value, purpose.value),
			insertToken(db, created.record),
		],
		{
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "token_issued",
			targetType: "token",
			targetId: created.record.id,
			beforeJson: beforeMeta !== null ? JSON.stringify(beforeMeta) : null,
			afterJson: JSON.stringify(afterMeta),
			revertedAt: null,
		},
	);

	return {
		ok: true,
		data: {
			token: created.token,
			tokenId: created.record.id,
			revokedPrevious: prevRow !== null,
		},
		changeId,
	};
}

export async function revokeAgentTokens(
	db: D1Database,
	input: RevokeAgentTokensInput,
): Promise<RevokeAgentTokensResult> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const purposeCheck =
		input.purpose !== undefined ? validateTokenPurpose(input.purpose) : null;
	if (purposeCheck !== null && !purposeCheck.ok) return purposeCheck;

	const activeQuery =
		purposeCheck !== null
			? db
					.prepare(
						`SELECT id, agent_id, purpose FROM tokens
						WHERE agent_id = ? AND purpose = ? AND revoked_at IS NULL
						ORDER BY created_at ASC, id ASC`,
					)
					.bind(agentId.value, purposeCheck.value)
			: db
					.prepare(
						`SELECT id, agent_id, purpose FROM tokens
						WHERE agent_id = ? AND revoked_at IS NULL
						ORDER BY created_at ASC, id ASC`,
					)
					.bind(agentId.value);

	const [agentResult, activeResult] = await db.batch([
		db.prepare("SELECT id FROM agents WHERE id = ?").bind(agentId.value),
		activeQuery,
	]);
	if ((agentResult?.results.length ?? 0) === 0) {
		return fail("not_found", "指定されたエージェントが見つかりません");
	}
	const activeRows = (activeResult?.results ?? []) as ActiveTokenMetaRow[];
	if (activeRows.length === 0) {
		return { ok: true, data: { revokedCount: 0 }, changeId: null };
	}

	const tokens = activeRows.map(toTokenMetadata);
	const revokeStmt =
		purposeCheck !== null
			? db
					.prepare(
						`UPDATE tokens SET revoked_at = ?
						WHERE agent_id = ? AND purpose = ? AND revoked_at IS NULL`,
					)
					.bind(ctx.value.now, agentId.value, purposeCheck.value)
			: db
					.prepare(
						`UPDATE tokens SET revoked_at = ?
						WHERE agent_id = ? AND revoked_at IS NULL`,
					)
					.bind(ctx.value.now, agentId.value);

	const targetId =
		tokens.length === 1 ? (tokens[0]?.id ?? agentId.value) : agentId.value;
	const changeId = await runWithChangeLog(db, [revokeStmt], {
		occurredAt: ctx.value.now,
		actorType: ctx.value.actorType,
		actorId: ctx.value.actorId,
		approverId: ctx.value.approverId,
		action: "token_revoked",
		targetType: "token",
		targetId,
		beforeJson: JSON.stringify({ agentId: agentId.value, tokens }),
		afterJson: null,
		revertedAt: null,
	});

	return {
		ok: true,
		data: { revokedCount: tokens.length },
		changeId,
	};
}
