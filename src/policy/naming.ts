// Validation for agent names, category names and descriptions (#47).
//
// Names and descriptions reach other agents in the line-based tool
// responses without any framing (design 3.3 leaves framing to stage 2).
// A name with a newline can inject a fake "kind: answer" line, and a
// category with ", " collides with the separator in list_agents.
// Stage 2 (#31, #32) and the admin bot (#36) register names from strings
// other people wrote, so the rules live here, shared between the seed
// loader (scripts/lib/seed.ts) and the admin operations (#29).
//
// Decisions:
//   * Names are stored NFC-normalized and trimmed, so canonically
//     equivalent Unicode sequences (such as "が" and "か" + U+3099) are
//     the same name, while case and halfwidth/fullwidth forms remain distinct.
//   * Names are 1 to 64 characters and forbid control/format/line-separator
//     characters and "," (the list separator).
//   * Descriptions are NFC-normalized, up to 1000 characters, and forbid
//     control characters other than newline and tab. The value is new
//     here; the description submission flow (#37) takes the same limit
//     from DESCRIPTION_MAX_LENGTH.
//   * Lengths count UTF-16 code units after NFC normalization.
//   * Nothing is retroactive: the seed loader only writes to an empty
//     database, and rows registered before these rules keep their names.

/** Maximum length of an agent or category name, in UTF-16 code units. */
export const NAME_MAX_LENGTH = 64;

/** Maximum length of a description, in UTF-16 code units. */
export const DESCRIPTION_MAX_LENGTH = 1000;

// \p{Cc} is C0/C1 control chars, \p{Cf} is format/bidi controls (such as
// U+202E), and \p{Zl}/\p{Zp} are Unicode line/paragraph separators
// (U+2028/U+2029). Names forbid all of them plus ",".
const NAME_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp},]/u;
// Descriptions are free text: newline and tab stay, the rest
// of the C0/C1 control characters goes.
function hasForbiddenDescriptionChar(text: string): boolean {
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (
			(code < 0x20 || (code >= 0x7f && code <= 0x9f)) &&
			ch !== "\n" &&
			ch !== "\t"
		) {
			return true;
		}
	}
	return false;
}

/** The stored form of a name: NFC-normalized, without outer whitespace. */
export function normalizeName(raw: string): string {
	return raw.normalize("NFC").trim();
}

/** Why a name cannot be used, or null when it can. */
export function nameProblem(raw: string): string | null {
	const name = normalizeName(raw);
	if (name.length === 0) {
		return "1文字以上にしてください";
	}
	if (name.length > NAME_MAX_LENGTH) {
		return `${NAME_MAX_LENGTH}文字以内にしてください（${name.length}文字あります）`;
	}
	if (NAME_FORBIDDEN.test(name)) {
		return "改行・制御文字・カンマ（,）は使えません";
	}
	return null;
}

/** The stored form of a description: NFC-normalized. */
export function normalizeDescription(raw: string): string {
	return raw.normalize("NFC");
}

/** Why a description cannot be used, or null when it can. */
export function descriptionProblem(raw: string): string | null {
	const description = normalizeDescription(raw);
	if (description.length > DESCRIPTION_MAX_LENGTH) {
		return `${DESCRIPTION_MAX_LENGTH}文字以内にしてください（${description.length}文字あります）`;
	}
	if (hasForbiddenDescriptionChar(description)) {
		return "制御文字（改行とタブ以外）は使えません";
	}
	return null;
}
