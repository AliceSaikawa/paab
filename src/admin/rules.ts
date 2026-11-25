import { type AllowRuleRow, allowRuleFromRow, insertAllowRule } from "../db";
import type { AllowRule } from "../types";
import type { AdminResult, AllowRuleInput } from "./types";
import {
	fail,
	isUniqueConstraintError,
	runWithChangeLog,
	validateContext,
	validateId,
} from "./validate";

function ruleTargetId(
	fromAgentId: string,
	toAgentId: string,
	categoryId: string,
): string {
	return `${fromAgentId}:${toAgentId}:${categoryId}`;
}

export async function grantAllowRule(
	db: D1Database,
	input: AllowRuleInput,
): Promise<AdminResult<{ rule: AllowRule }>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const fromAgentId = validateId(input.fromAgentId, "送信元エージェントID");
	if (!fromAgentId.ok) return fromAgentId;

	const toAgentId = validateId(input.toAgentId, "宛先エージェントID");
	if (!toAgentId.ok) return toAgentId;

	const categoryId = validateId(input.categoryId, "カテゴリID");
	if (!categoryId.ok) return categoryId;

	if (fromAgentId.value === toAgentId.value) {
		return fail(
			"self_addressed",
			"自分自身への質問を許可するルールは作成できません",
		);
	}

	const [fromResult, toResult, catResult, ruleResult] = await db.batch([
		db.prepare("SELECT id FROM agents WHERE id = ?").bind(fromAgentId.value),
		db.prepare("SELECT id FROM agents WHERE id = ?").bind(toAgentId.value),
		db.prepare("SELECT id FROM categories WHERE id = ?").bind(categoryId.value),
		db
			.prepare(
				`SELECT * FROM allow_rules
				WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?`,
			)
			.bind(fromAgentId.value, toAgentId.value, categoryId.value),
	]);

	if ((fromResult?.results.length ?? 0) === 0) {
		return fail("not_found", "送信元エージェントが見つかりません");
	}
	if ((toResult?.results.length ?? 0) === 0) {
		return fail("not_found", "宛先エージェントが見つかりません");
	}
	if ((catResult?.results.length ?? 0) === 0) {
		return fail("not_found", "カテゴリが見つかりません");
	}
	if ((ruleResult?.results.length ?? 0) > 0) {
		return fail("duplicate_rule", "同じ許可ルールがすでに存在します");
	}

	const rule: AllowRule = {
		fromAgentId: fromAgentId.value,
		toAgentId: toAgentId.value,
		categoryId: categoryId.value,
		createdAt: ctx.value.now,
	};
	const targetId = ruleTargetId(
		rule.fromAgentId,
		rule.toAgentId,
		rule.categoryId,
	);

	try {
		const changeId = await runWithChangeLog(db, [insertAllowRule(db, rule)], {
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "allow_rule_granted",
			targetType: "allow_rule",
			targetId,
			beforeJson: null,
			afterJson: JSON.stringify(rule),
			revertedAt: null,
		});
		return { ok: true, data: { rule }, changeId };
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			return fail("duplicate_rule", "同じ許可ルールがすでに存在します");
		}
		throw error;
	}
}

export async function revokeAllowRule(
	db: D1Database,
	input: AllowRuleInput,
): Promise<AdminResult<{ rule: AllowRule }>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const fromAgentId = validateId(input.fromAgentId, "送信元エージェントID");
	if (!fromAgentId.ok) return fromAgentId;

	const toAgentId = validateId(input.toAgentId, "宛先エージェントID");
	if (!toAgentId.ok) return toAgentId;

	const categoryId = validateId(input.categoryId, "カテゴリID");
	if (!categoryId.ok) return categoryId;

	const row = await db
		.prepare(
			`SELECT * FROM allow_rules
			WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?`,
		)
		.bind(fromAgentId.value, toAgentId.value, categoryId.value)
		.first<AllowRuleRow>();
	if (row === null) {
		return fail("not_found", "指定された許可ルールが見つかりません");
	}
	const rule = allowRuleFromRow(row);
	const targetId = ruleTargetId(
		rule.fromAgentId,
		rule.toAgentId,
		rule.categoryId,
	);

	const changeId = await runWithChangeLog(
		db,
		[
			db
				.prepare(
					`DELETE FROM allow_rules
					WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?`,
				)
				.bind(rule.fromAgentId, rule.toAgentId, rule.categoryId),
		],
		{
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "allow_rule_revoked",
			targetType: "allow_rule",
			targetId,
			beforeJson: JSON.stringify(rule),
			afterJson: null,
			revertedAt: null,
		},
	);
	return { ok: true, data: { rule }, changeId };
}
