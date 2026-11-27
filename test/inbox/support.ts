import type { MessageRow } from "../../src/db";
import { submitQuestion } from "../../src/inbox";
import type { Agent, Category } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { seedAgent, seedCategory, T0 } from "../helpers/fixtures";

export interface World {
	db: D1Database;
	asker: Agent;
	responder: Agent;
	bystander: Agent;
	category: Category;
}

/** An empty database with three agents and one category. */
export async function createWorld(): Promise<World> {
	const db = await createTestDb();
	return {
		db,
		asker: await seedAgent(db),
		responder: await seedAgent(db),
		bystander: await seedAgent(db),
		category: await seedCategory(db),
	};
}

/** Stores a question from the asker to the responder at `now`. */
export async function ask(
	world: World,
	now: number = T0,
	body = "When are you free?",
) {
	const result = await submitQuestion(world.db, {
		fromAgentId: world.asker.id,
		toAgentId: world.responder.id,
		categoryId: world.category.id,
		body,
		now,
	});
	if (!result.ok) {
		throw new Error(`submitQuestion failed: ${result.reason}`);
	}
	return result;
}

export async function getRow(db: D1Database, id: string): Promise<MessageRow> {
	const row = await db
		.prepare("SELECT * FROM messages WHERE id = ?")
		.bind(id)
		.first<MessageRow>();
	if (row === null) {
		throw new Error(`No message ${id}`);
	}
	return row;
}

export async function repliesTo(
	db: D1Database,
	questionId: string,
): Promise<MessageRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM messages WHERE in_reply_to = ?")
		.bind(questionId)
		.all<MessageRow>();
	return results;
}
