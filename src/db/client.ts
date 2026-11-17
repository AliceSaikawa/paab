/** Returns the D1 database bound to the Worker. */
export function getDb(env: Pick<Env, "DB">): D1Database {
	return env.DB;
}

/** Generates an ID for a new agent, token, category or message. */
export function newId(): string {
	return crypto.randomUUID();
}
