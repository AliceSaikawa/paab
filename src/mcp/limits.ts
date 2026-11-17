/** Longest question an agent may ask, in Unicode code points. */
export const QUESTION_MAX_LENGTH = 2000;

/** Longest answer an agent may give, in Unicode code points. */
export const ANSWER_MAX_LENGTH = 4000;

/**
 * Counts code points rather than UTF-16 units, so that a character outside
 * the Basic Multilingual Plane counts once.
 */
export function textLength(text: string): number {
	return [...text].length;
}

export function isBlank(text: string): boolean {
	return text.trim().length === 0;
}
