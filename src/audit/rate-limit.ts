import type { UnixMillis } from "../types";

/** Maximum `answer_failed` audit writes per agent per isolate within one window. */
export const ANSWER_FAILED_AUDIT_LIMIT = 20;

/** Length of one per-isolate rate-limit window for `answer_failed` audit writes. */
export const ANSWER_FAILED_AUDIT_WINDOW_MS = 60_000;

const MAX_TRACKED_KEYS = 1024;

interface WindowCounter {
	windowStart: UnixMillis;
	count: number;
}

const answerFailedCounters = new Map<string, WindowCounter>();

/**
 * Per-isolate guard against D1 write amplification from repeated failed
 * `answer` calls. Allows at most `ANSWER_FAILED_AUDIT_LIMIT` audit writes per
 * agent per `ANSWER_FAILED_AUDIT_WINDOW_MS` window within this isolate.
 */
export function allowAnswerFailedAudit(
	agentId: string,
	now: UnixMillis,
): boolean {
	const existing = answerFailedCounters.get(agentId);
	if (
		existing === undefined ||
		now < existing.windowStart ||
		now - existing.windowStart >= ANSWER_FAILED_AUDIT_WINDOW_MS
	) {
		if (answerFailedCounters.size >= MAX_TRACKED_KEYS) {
			for (const [key, counter] of answerFailedCounters) {
				if (
					now < counter.windowStart ||
					now - counter.windowStart >= ANSWER_FAILED_AUDIT_WINDOW_MS
				) {
					answerFailedCounters.delete(key);
				}
			}
			if (answerFailedCounters.size >= MAX_TRACKED_KEYS) {
				answerFailedCounters.clear();
			}
		}
		answerFailedCounters.set(agentId, { windowStart: now, count: 1 });
		return true;
	}
	if (existing.count >= ANSWER_FAILED_AUDIT_LIMIT) {
		return false;
	}
	existing.count += 1;
	return true;
}

/** Clears per-isolate `answer_failed` audit rate-limit counters (for tests). */
export function resetAnswerFailedAuditLimit(): void {
	answerFailedCounters.clear();
}
