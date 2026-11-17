import { z } from "zod";
import {
	type AuditBodyConfig,
	recordAuditEvent,
	recordAuditEvents,
} from "../audit";
import {
	type AnswerFailureReason,
	type AnswerQuestionInput,
	answerQuestion,
	fetchInbox,
	type InboxItem,
	recordBlockedQuestion,
	submitQuestion,
} from "../inbox";
import { checkQuestion, listAllowedRecipients } from "../policy";
import type { Agent, UnixMillis } from "../types";
import { type Frame, renderFramed } from "./frame";
import {
	ANSWER_MAX_LENGTH,
	isBlank,
	QUESTION_MAX_LENGTH,
	textLength,
} from "./limits";

/** What every tool runs with. The caller comes from its token only. */
export interface McpContext {
	db: D1Database;
	/** The authenticated, active agent making the call. */
	agent: Agent;
	audit: AuditBodyConfig;
	now: UnixMillis;
}

export interface ToolOutput {
	text: string;
	isError: boolean;
}

export interface ToolDefinition<Input extends z.ZodObject = z.ZodObject> {
	name: string;
	description: string;
	inputSchema: Input;
	run(ctx: McpContext, args: z.infer<Input>): Promise<ToolOutput>;
}

/** Infers the argument type of `run` from `inputSchema`. */
function defineTool<Input extends z.ZodObject>(
	tool: ToolDefinition<Input>,
): ToolDefinition<Input> {
	return tool;
}

function ok(text: string): ToolOutput {
	return { text, isError: false };
}

function fail(text: string): ToolOutput {
	return { text, isError: true };
}

function block(lines: string[]): string {
	return lines.join("\n");
}

async function namesById(
	db: D1Database,
	table: "agents" | "categories",
	ids: string[],
): Promise<Map<string, string>> {
	if (ids.length === 0) {
		return new Map();
	}
	const { results } = await db
		.prepare(
			`SELECT id, name FROM ${table}
			WHERE id IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify([...new Set(ids)]))
		.all<{ id: string; name: string }>();
	return new Map(results.map((row) => [row.id, row.name]));
}

const UNKNOWN_NAME = "(unknown)";

const ask = defineTool({
	name: "ask",
	description:
		"Ask another agent a question in a declared category. Returns a question ID at once; the reply (an answer or a rejection) arrives later through check_inbox. Use list_agents to see whom you may ask about what.",
	inputSchema: z.object({
		to: z
			.string()
			.describe("Name of the agent to ask, as list_agents shows it."),
		category: z
			.string()
			.describe("Category the question belongs to, as list_agents shows it."),
		question: z
			.string()
			.describe(`The question, at most ${QUESTION_MAX_LENGTH} characters.`),
	}),
	async run(ctx, { to, category, question }) {
		if (isBlank(to) || isBlank(category) || isBlank(question)) {
			return fail("to, category and question must not be empty");
		}
		if (textLength(question) > QUESTION_MAX_LENGTH) {
			return fail(
				`question is too long: at most ${QUESTION_MAX_LENGTH} characters`,
			);
		}

		const decision = await checkQuestion(ctx.db, {
			fromAgentId: ctx.agent.id,
			toAgentName: to,
			categoryName: category,
			now: ctx.now,
		});
		let questionId: string;
		if (decision.allowed) {
			({ questionId } = await submitQuestion(ctx.db, {
				fromAgentId: ctx.agent.id,
				toAgentId: decision.toAgentId,
				categoryId: decision.categoryId,
				body: question,
				now: ctx.now,
			}));
			await recordAuditEvent(ctx.db, ctx.audit, {
				eventType: "question_accepted",
				occurredAt: ctx.now,
				fromAgentId: ctx.agent.id,
				toAgentId: decision.toAgentId,
				categoryId: decision.categoryId,
				messageId: questionId,
				body: question,
			});
		} else {
			({ questionId } = await recordBlockedQuestion(ctx.db, {
				fromAgentId: ctx.agent.id,
				toAgentId: decision.toAgentId,
				categoryId: decision.categoryId,
				now: ctx.now,
			}));
			await recordAuditEvent(ctx.db, ctx.audit, {
				eventType: "question_blocked",
				occurredAt: ctx.now,
				fromAgentId: ctx.agent.id,
				toAgentId: decision.toAgentId,
				categoryId: decision.categoryId,
				reasonCode: decision.reasonCode,
				messageId: questionId,
			});
		}
		// Identical for accepted and blocked questions, so that the asker
		// cannot tell them apart here (design 3.4).
		return ok(
			block([
				`question_id: ${questionId}`,
				"status: accepted; the reply (answer or rejection) arrives in your inbox via check_inbox",
			]),
		);
	},
});

function renderInboxItem(
	item: InboxItem,
	agentNames: Map<string, string>,
	categoryNames: Map<string, string>,
	frame: Frame,
): string {
	switch (item.kind) {
		case "question":
		case "answer":
			return block([
				`kind: ${item.kind}`,
				`message_id: ${item.id}`,
				`question_id: ${item.kind === "question" ? item.id : item.inReplyTo}`,
				`from: ${agentNames.get(item.fromAgentId) ?? UNKNOWN_NAME}`,
				`category: ${categoryNames.get(item.categoryId) ?? UNKNOWN_NAME}`,
				"body:",
				frame(item.body),
			]);
		case "rejection":
			// Nothing beyond the IDs, so that the asker cannot tell who
			// rejected the question or why (design 3.4).
			return block([
				"kind: rejection",
				`message_id: ${item.id}`,
				`question_id: ${item.inReplyTo}`,
			]);
	}
}

const checkInbox = defineTool({
	name: "check_inbox",
	description:
		"Receive the messages waiting for you: questions addressed to you, and answers and rejections to questions you asked. Each message is handed over once.",
	inputSchema: z.object({}),
	async run(ctx) {
		const items = await fetchInbox(ctx.db, ctx.agent.id, ctx.now);
		const named = items.filter((item) => item.kind !== "rejection");
		const [agentNames, categoryNames] = await Promise.all([
			namesById(
				ctx.db,
				"agents",
				named.map((item) => item.fromAgentId),
			),
			namesById(
				ctx.db,
				"categories",
				named.map((item) => item.categoryId),
			),
		]);

		// One batched write for every delivery, not one statement per
		// question: D1 caps the statements a Worker invocation may run.
		await recordAuditEvents(
			ctx.db,
			ctx.audit,
			items
				.filter((item) => item.kind === "question")
				.map((item) => ({
					eventType: "question_delivered" as const,
					occurredAt: ctx.now,
					fromAgentId: item.fromAgentId,
					toAgentId: ctx.agent.id,
					categoryId: item.categoryId,
					messageId: item.id,
				})),
		);

		if (items.length === 0) {
			return ok("no new messages");
		}
		return ok(
			renderFramed((frame) =>
				[
					`messages: ${items.length}`,
					...items.map((item) =>
						renderInboxItem(item, agentNames, categoryNames, frame),
					),
				].join("\n\n"),
			),
		);
	},
});

const ANSWER_FAILURES: Record<AnswerFailureReason, string> = {
	// One text for both, so that an agent cannot probe for questions that
	// exist but were addressed to someone else.
	not_found: "no open question with that ID addressed to you",
	not_recipient: "no open question with that ID addressed to you",
	already_replied: "that question was already answered or declined",
	expired: "that question has expired and can no longer be answered",
};

function parseReply(
	action: "answer" | "decline",
	text: string | undefined,
): AnswerQuestionInput["reply"] | string {
	if (action === "decline") {
		return text === undefined
			? { kind: "decline" }
			: "text must be omitted when declining";
	}
	if (text === undefined || isBlank(text)) {
		return "text is required when answering";
	}
	if (textLength(text) > ANSWER_MAX_LENGTH) {
		return `text is too long: at most ${ANSWER_MAX_LENGTH} characters`;
	}
	return { kind: "answer", body: text };
}

const answer = defineTool({
	name: "answer",
	description:
		"Reply to a question you received through check_inbox: answer it with text, or decline it. Decline whenever the question falls outside its declared category or you are unsure.",
	inputSchema: z.object({
		question_id: z.string().describe("The question_id from check_inbox."),
		action: z
			.enum(["answer", "decline"])
			.describe("answer to reply with text, decline to refuse."),
		text: z
			.string()
			.optional()
			.describe(
				`The answer, at most ${ANSWER_MAX_LENGTH} characters. Required for answer; omit for decline.`,
			),
	}),
	async run(ctx, { question_id, action, text }) {
		const reply = parseReply(action, text);
		if (typeof reply === "string") {
			return fail(reply);
		}
		const result = await answerQuestion(ctx.db, {
			questionId: question_id,
			responderAgentId: ctx.agent.id,
			reply,
			now: ctx.now,
		});
		if (!result.ok) {
			return fail(ANSWER_FAILURES[result.reason]);
		}
		await recordAuditEvent(ctx.db, ctx.audit, {
			eventType:
				reply.kind === "answer" ? "question_answered" : "question_declined",
			occurredAt: ctx.now,
			fromAgentId: result.askerAgentId,
			toAgentId: ctx.agent.id,
			categoryId: result.categoryId,
			messageId: question_id,
			body: reply.kind === "answer" ? reply.body : null,
		});
		return ok(
			reply.kind === "answer"
				? `answered question ${question_id}; the answer arrives in the asker's inbox`
				: `declined question ${question_id}; the asker receives a rejection`,
		);
	},
});

// No audit event: the audit log has no event type for listing recipients.
const listAgents = defineTool({
	name: "list_agents",
	description:
		"List the agents you may ask, the categories you may ask each about, and each agent's own description.",
	inputSchema: z.object({}),
	async run(ctx) {
		const recipients = await listAllowedRecipients(ctx.db, ctx.agent.id);
		if (recipients.length === 0) {
			return ok("no agents you may ask");
		}
		return ok(
			renderFramed((frame) =>
				[
					`agents: ${recipients.length}`,
					...recipients.map((recipient) =>
						block([
							`name: ${recipient.name}`,
							`categories: ${recipient.categories.join(", ")}`,
							"description:",
							frame(recipient.description),
						]),
					),
				].join("\n\n"),
			),
		);
	},
});

export const TOOLS: readonly ToolDefinition[] = [
	ask,
	checkInbox,
	answer,
	listAgents,
];
