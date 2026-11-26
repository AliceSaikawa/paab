import {
	type AllowRuleRow,
	allowRuleFromRow,
	type CategoryRow,
	categoryFromRow,
	insertCategory,
	newId,
} from "../db";
import type { Category } from "../types";
import type {
	AdminResult,
	CategoryDeletionSnapshot,
	CreateCategoryInput,
	DeleteCategoryInput,
	DeletedCategorySummary,
} from "./types";
import {
	fail,
	isUniqueConstraintError,
	runWithChangeLog,
	validateContext,
	validateId,
	validateName,
} from "./validate";

export async function createCategory(
	db: D1Database,
	input: CreateCategoryInput,
): Promise<AdminResult<{ category: Category }>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const name = validateName(input.name);
	if (!name.ok) return name;

	const existing = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name.value)
		.first<{ id: string }>();
	if (existing !== null) {
		return fail(
			"duplicate_name",
			`カテゴリ「${name.value}」はすでに存在します`,
		);
	}

	const category: Category = { id: newId(), name: name.value };
	try {
		const changeId = await runWithChangeLog(
			db,
			[insertCategory(db, category)],
			{
				occurredAt: ctx.value.now,
				actorType: ctx.value.actorType,
				actorId: ctx.value.actorId,
				approverId: ctx.value.approverId,
				action: "category_created",
				targetType: "category",
				targetId: category.id,
				beforeJson: null,
				afterJson: JSON.stringify(category),
				revertedAt: null,
			},
		);
		return { ok: true, data: { category }, changeId };
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			return fail(
				"duplicate_name",
				`カテゴリ「${name.value}」はすでに存在します`,
			);
		}
		throw error;
	}
}

export async function deleteCategory(
	db: D1Database,
	input: DeleteCategoryInput,
): Promise<AdminResult<DeletedCategorySummary>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const categoryId = validateId(input.categoryId, "カテゴリID");
	if (!categoryId.ok) return categoryId;

	const [catResult, rulesResult] = await db.batch([
		db.prepare("SELECT * FROM categories WHERE id = ?").bind(categoryId.value),
		db
			.prepare(
				`SELECT * FROM allow_rules
				WHERE category_id = ?
				ORDER BY from_agent_id, to_agent_id`,
			)
			.bind(categoryId.value),
	]);
	const catRow = (catResult?.results[0] ?? null) as CategoryRow | null;
	if (catRow === null) {
		return fail("not_found", "指定されたカテゴリが見つかりません");
	}
	const category = categoryFromRow(catRow);
	const allowRules = ((rulesResult?.results ?? []) as AllowRuleRow[]).map(
		allowRuleFromRow,
	);
	const snapshot: CategoryDeletionSnapshot = { category, allowRules };

	const changeId = await runWithChangeLog(
		db,
		[db.prepare("DELETE FROM categories WHERE id = ?").bind(category.id)],
		{
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "category_deleted",
			targetType: "category",
			targetId: category.id,
			beforeJson: JSON.stringify(snapshot),
			afterJson: null,
			revertedAt: null,
		},
	);
	return {
		ok: true,
		data: { category, deletedAllowRuleCount: allowRules.length },
		changeId,
	};
}
