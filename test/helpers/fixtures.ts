import { insertAgent, insertCategory, newId } from "../../src/db";
import type { Agent, Category } from "../../src/types";

/** A fixed instant for tests: 2026-11-16T00:00:00.000Z. */
export const T0 = Date.UTC(2026, 10, 16);

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** Inserts an agent, filling in whatever `overrides` leaves out. */
export async function seedAgent(
	db: D1Database,
	overrides: Partial<Agent> = {},
): Promise<Agent> {
	const id = overrides.id ?? newId();
	const agent: Agent = {
		id,
		ownerId: "owner-1",
		name: `agent-${id}`,
		description: "",
		status: "active",
		dailyQuestionLimit: 20,
		createdAt: T0,
		...overrides,
	};
	await insertAgent(db, agent).run();
	return agent;
}

/** Inserts a category, filling in whatever `overrides` leaves out. */
export async function seedCategory(
	db: D1Database,
	overrides: Partial<Category> = {},
): Promise<Category> {
	const id = overrides.id ?? newId();
	const category: Category = { id, name: `category-${id}`, ...overrides };
	await insertCategory(db, category).run();
	return category;
}
