import { describe, expect, it } from "vitest";
import crontabExample from "../../examples/poll-unread/crontab.example?raw";
import pollUnreadSh from "../../examples/poll-unread/poll-unread.sh?raw";
import wakeSh from "../../examples/poll-unread/wake.sh?raw";

describe("examples/poll-unread structural contracts", () => {
	it("poll-unread.sh uses POSIX sh with set -eu and no bash/jq dependencies", () => {
		expect(pollUnreadSh.startsWith("#!/bin/sh\n")).toBe(true);
		expect(pollUnreadSh).toMatch(/^set -eu$/m);
		expect(pollUnreadSh).not.toContain("#!/bin/bash");
		expect(pollUnreadSh).not.toContain("pipefail");
		expect(pollUnreadSh).not.toMatch(/\bjq\b/);
		expect(pollUnreadSh).not.toContain("[[");
	});

	it("poll-unread.sh passes bearer auth via curl --config - on stdin without -L or hardcoded tokens", () => {
		expect(pollUnreadSh).toContain("curl ");
		expect(pollUnreadSh).toContain("--config -");
		expect(pollUnreadSh).toMatch(
			/header = "Authorization: Bearer \$\{escaped_token\}"/,
		);
		expect(pollUnreadSh).not.toMatch(
			/curl[^\n]*(?:-H|--header)\s+["']?Authorization:/,
		);
		expect(pollUnreadSh).not.toMatch(/curl[^\n]*(?:\s-L\b|--location\b)/);
		expect(pollUnreadSh).toContain("PAAB_UNREAD_TOKEN");
		expect(pollUnreadSh).toContain("PAAB_UNREAD_TOKEN_FILE");
		expect(pollUnreadSh).toContain("PAAB_STATE_FILE");
		expect(pollUnreadSh).toContain("PAAB_CURL_TIMEOUT");
	});

	it("poll-unread.sh delegates waking via PAAB_WAKE_SCRIPT and updates state atomically", () => {
		expect(pollUnreadSh).toContain("PAAB_WAKE_SCRIPT");
		expect(pollUnreadSh).toContain("PAAB_UNREAD_COUNT");
		expect(pollUnreadSh).toContain("PAAB_PREV_UNREAD_COUNT");
		expect(pollUnreadSh).toContain("wake.sh");
		expect(pollUnreadSh).toMatch(/\bmv\b/);
	});

	it("wake.sh uses POSIX sh with set -eu and prints the sample notification", () => {
		expect(wakeSh.startsWith("#!/bin/sh\n")).toBe(true);
		expect(wakeSh).toMatch(/^set -eu$/m);
		expect(wakeSh).toContain("[paab] new unread messages:");
		expect(wakeSh).toContain("PAAB_WAKE_SCRIPT");
	});

	it("crontab.example runs every 5 minutes using PAAB_UNREAD_TOKEN_FILE without hardcoding a token", () => {
		const activeLines = crontabExample
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"));

		const cronLine = activeLines.find((line) =>
			line.startsWith("*/5 * * * * "),
		);
		expect(cronLine).toBeDefined();
		expect(cronLine).toContain("PAAB_URL=");
		expect(cronLine).toContain("PAAB_UNREAD_TOKEN_FILE=");
		expect(cronLine).toContain("poll-unread.sh");
		expect(cronLine).not.toContain("PAAB_UNREAD_TOKEN=");
		expect(crontabExample).toContain("600");
	});
});
