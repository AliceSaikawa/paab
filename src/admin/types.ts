import type {
	Agent,
	AgentStatus,
	AllowRule,
	Category,
	ChangeActorType,
	ChangeTargetType,
	TokenPurpose,
	UnixMillis,
} from "../types";

export interface ChangeActor {
	actorType: ChangeActorType;
	actorId: string;
	approverId?: string | null;
}

export type AdminErrorCode =
	| "invalid_name"
	| "invalid_description"
	| "invalid_limit"
	| "invalid_input"
	| "not_found"
	| "duplicate_name"
	| "already_suspended"
	| "already_active"
	| "self_addressed"
	| "duplicate_rule";

export interface AdminFailure {
	ok: false;
	code: AdminErrorCode;
	message: string;
}

export type AdminResult<T, C extends number | null = number> =
	| { ok: true; data: T; changeId: C }
	| AdminFailure;

export type UpdateAgentResult =
	| { ok: true; data: { agent: Agent; changed: true }; changeId: number }
	| { ok: true; data: { agent: Agent; changed: false }; changeId: null }
	| AdminFailure;

export type RevokeAgentTokensResult =
	| { ok: true; data: { revokedCount: number }; changeId: number }
	| { ok: true; data: { revokedCount: 0 }; changeId: null }
	| AdminFailure;

export interface RegisterAgentInput {
	name: string;
	description?: string;
	dailyQuestionLimit: number;
	ownerId?: string;
	status?: AgentStatus;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface UpdateAgentInput {
	agentId: string;
	name?: string;
	description?: string;
	dailyQuestionLimit?: number;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface DeleteAgentInput {
	agentId: string;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface DeletedAgentSummary {
	agent: Agent;
	deletedAllowRuleCount: number;
}

export interface AgentStatusChangeInput {
	agentId: string;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface IssueAgentTokenInput {
	agentId: string;
	purpose: TokenPurpose;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface IssuedAgentToken {
	/** Plaintext token shown once to the caller and never persisted. */
	token: string;
	tokenId: string;
	revokedPrevious: boolean;
}

export interface RevokeAgentTokensInput {
	agentId: string;
	purpose?: TokenPurpose;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface CreateCategoryInput {
	name: string;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface DeleteCategoryInput {
	categoryId: string;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface DeletedCategorySummary {
	category: Category;
	deletedAllowRuleCount: number;
}

export interface AllowRuleInput {
	fromAgentId: string;
	toAgentId: string;
	categoryId: string;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface ChangeLogFilter {
	occurredFrom?: UnixMillis;
	occurredBefore?: UnixMillis;
	actorType?: ChangeActorType;
	targetType?: ChangeTargetType;
	targetId?: string;
	beforeId?: number;
	limit?: number;
}

export interface ActiveTokenSummary {
	id: string;
	purpose: TokenPurpose;
	createdAt: UnixMillis;
}

export interface AgentWithStatus {
	agent: Agent;
	todayQuestionCount: number;
	activeTokens: Record<TokenPurpose, ActiveTokenSummary | null>;
}

export interface CategoryWithUsage {
	category: Category;
	allowRuleCount: number;
}

export interface AllowRuleCategory {
	categoryId: string;
	categoryName: string;
	createdAt: UnixMillis;
}

export interface AllowRuleGroup {
	fromAgentId: string;
	fromAgentName: string;
	fromAgentStatus: AgentStatus;
	toAgentId: string;
	toAgentName: string;
	toAgentStatus: AgentStatus;
	categories: AllowRuleCategory[];
}

export interface TokenAuditMetadata {
	id: string;
	purpose: TokenPurpose;
	agentId: string;
}

export interface AgentDeletionSnapshot {
	agent: Agent;
	allowRules: AllowRule[];
}

export interface CategoryDeletionSnapshot {
	category: Category;
	allowRules: AllowRule[];
}
