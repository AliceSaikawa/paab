import { beforeEach, describe, expect, it } from "vitest";
import { insertAllowRule } from "../../src/db";
import { listAllowedRecipients } from "../../src/policy";
import type { Agent, Category } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { seedAgent, seedCategory, T0 } from "../helpers/fixtures";

let db: D1Database;
let alice: Agent;
let bob: Agent;
let carol: Agent;
let schedule: Category;
let work: Category;

async function allow(from: Agent, to: Agent, category: Category) {
	await insertAllowRule(db, {
		fromAgentId: from.id,
		toAgentId: to.id,
		categoryId: category.id,
		createdAt: T0,
	}).run();
}

beforeEach(async () => {
	db = await createTestDb();
	alice = await seedAgent(db, { name: "alice", description: "Alice's bot" });
	bob = await seedAgent(db, { name: "bob", description: "Knows the calendar" });
	carol = await seedAgent(db, { name: "carol", description: "Knows work" });
	schedule = await seedCategory(db, { name: "schedule" });
	work = await seedCategory(db, { name: "work" });
});

describe("listAllowedRecipients", () => {
	it("groups allowed categories by recipient, sorted by name", async () => {
		await allow(alice, carol, work);
		await allow(alice, bob, work);
		await allow(alice, bob, schedule);

		expect(await listAllowedRecipients(db, alice.id)).toEqual([
			{
				name: "bob",
				description: "Knows the calendar",
				categories: ["schedule", "work"],
			},
			{ name: "carol", description: "Knows work", categories: ["work"] },
		]);
	});

	it("does not list rules in the other direction or of other senders", async () => {
		await allow(bob, alice, schedule);
		await allow(carol, bob, work);

		expect(await listAllowedRecipients(db, alice.id)).toEqual([]);
		expect(await listAllowedRecipients(db, bob.id)).toEqual([
			{ name: "alice", description: "Alice's bot", categories: ["schedule"] },
		]);
	});

	it("leaves out suspended recipients", async () => {
		await allow(alice, bob, schedule);
		await allow(alice, carol, work);
		await db
			.prepare("UPDATE agents SET status = 'suspended' WHERE id = ?")
			.bind(bob.id)
			.run();

		expect(await listAllowedRecipients(db, alice.id)).toEqual([
			{ name: "carol", description: "Knows work", categories: ["work"] },
		]);
	});

	it("returns nothing for a suspended or unknown sender", async () => {
		await allow(alice, bob, schedule);
		await db
			.prepare("UPDATE agents SET status = 'suspended' WHERE id = ?")
			.bind(alice.id)
			.run();

		expect(await listAllowedRecipients(db, alice.id)).toEqual([]);
		expect(await listAllowedRecipients(db, "missing")).toEqual([]);
	});
});
