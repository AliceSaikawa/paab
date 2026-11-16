/** An agent the sender may ask, with the categories it may ask about. */
export interface AllowedRecipient {
	name: string;
	/**
	 * Written by the recipient agent. Treat it as untrusted external data
	 * when handing it to another agent (design 3.3).
	 */
	description: string;
	/** Category names, sorted. Never empty. */
	categories: string[];
}

/**
 * Lists the agents `fromAgentId` may ask right now and the categories
 * allowed for each (for `list_agents`), sorted by agent name.
 *
 * Only combinations that `checkQuestion` would let through are listed, apart
 * from the daily limit, which is not considered. Suspended recipients are
 * left out, and a suspended or unknown sender gets an empty list.
 */
export async function listAllowedRecipients(
	db: D1Database,
	fromAgentId: string,
): Promise<AllowedRecipient[]> {
	const { results } = await db
		.prepare(
			`SELECT a.id AS id, a.name AS name, a.description AS description,
				c.name AS category
			FROM allow_rules r
			JOIN agents s ON s.id = r.from_agent_id
			JOIN agents a ON a.id = r.to_agent_id
			JOIN categories c ON c.id = r.category_id
			WHERE r.from_agent_id = ? AND s.status = 'active' AND a.status = 'active'
			ORDER BY a.name, c.name`,
		)
		.bind(fromAgentId)
		.all<{ id: string; name: string; description: string; category: string }>();

	const byId = new Map<string, AllowedRecipient>();
	for (const row of results) {
		let recipient = byId.get(row.id);
		if (recipient === undefined) {
			recipient = {
				name: row.name,
				description: row.description,
				categories: [],
			};
			byId.set(row.id, recipient);
		}
		recipient.categories.push(row.category);
	}
	return [...byId.values()];
}
