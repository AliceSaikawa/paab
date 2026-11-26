const SAFE_HTML_BRAND: unique symbol = Symbol("SafeHtml");

/** HTML that has already been built through `html` or explicitly trusted via `rawHtml`. */
export interface SafeHtml {
	readonly [SAFE_HTML_BRAND]: true;
	readonly html: string;
}

export type HtmlValue =
	| SafeHtml
	| string
	| number
	| false
	| null
	| undefined
	| readonly HtmlValue[];

const HTML_ESCAPE_MAP: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Escapes `&`, `<`, `>`, `"`, and `'` for safe HTML text and attribute interpolation. */
export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

export function isSafeHtml(value: unknown): value is SafeHtml {
	return (
		typeof value === "object" && value !== null && SAFE_HTML_BRAND in value
	);
}

/** Wraps an already-safe HTML string as `SafeHtml`. Never pass untrusted input here. */
export function rawHtml(value: string): SafeHtml {
	return { [SAFE_HTML_BRAND]: true, html: value };
}

function renderHtmlValue(value: HtmlValue): string {
	if (value === null || value === undefined || value === false) {
		return "";
	}
	if (Array.isArray(value)) {
		return value.map((item) => renderHtmlValue(item)).join("");
	}
	if (isSafeHtml(value)) {
		return value.html;
	}
	return escapeHtml(String(value));
}

/** Tagged template that escapes every interpolated value unless it is already `SafeHtml`. */
export function html(
	strings: TemplateStringsArray,
	...values: readonly HtmlValue[]
): SafeHtml {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i += 1) {
		out += renderHtmlValue(values[i]);
		out += strings[i + 1] ?? "";
	}
	return rawHtml(out);
}
