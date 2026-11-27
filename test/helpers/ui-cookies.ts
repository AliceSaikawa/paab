import { csrfCookieName, FLASH_COOKIE_NAME } from "../../src/ui";

export class TestCookieJar {
	private readonly cookies = new Map<string, string>();

	applyResponse(response: Response): string[] {
		const setCookies = response.headers.getSetCookie();
		for (const header of setCookies) {
			const parts = header.split(";").map((part) => part.trim());
			const first = parts[0] ?? "";
			const eq = first.indexOf("=");
			if (eq <= 0) {
				continue;
			}
			const name = first.slice(0, eq).trim();
			const value = first.slice(eq + 1).trim();
			const maxAgeZero = parts.some(
				(part) => part.toLowerCase() === "max-age=0",
			);
			if (maxAgeZero || value.length === 0) {
				this.cookies.delete(name);
			} else {
				this.cookies.set(name, value);
			}
		}
		return setCookies;
	}

	header(): string {
		return [...this.cookies.entries()]
			.map(([name, value]) => `${name}=${value}`)
			.join("; ");
	}

	get(name: string): string | undefined {
		return this.cookies.get(name);
	}

	csrfToken(url: URL): string | undefined {
		return this.cookies.get(csrfCookieName(url));
	}

	csrfCookiePair(url: URL): string {
		const name = csrfCookieName(url);
		const value = this.cookies.get(name);
		return value !== undefined ? `${name}=${value}` : "";
	}

	hasFlash(): boolean {
		return this.cookies.has(FLASH_COOKIE_NAME);
	}
}

export function findSetCookie(
	response: Response,
	cookieName: string,
): string | undefined {
	return response.headers
		.getSetCookie()
		.find((header) => header.startsWith(`${cookieName}=`));
}
