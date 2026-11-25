import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pollScript = join(repoRoot, "examples", "poll-unread.sh");
const wakeScript = join(repoRoot, "examples", "wake-agent.sh");

function runCommand(command, args, env, cwd = repoRoot) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", rejectPromise);
		child.on("close", (code, signal) => {
			resolvePromise({ code, signal, stdout, stderr });
		});
	});
}

async function withServer(handler, fn) {
	const requests = [];
	const server = createServer((req, res) => {
		requests.push({
			method: req.method,
			url: req.url,
			authorization: req.headers.authorization,
		});
		handler(req, res);
	});
	await new Promise((resolvePromise) => {
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Expected TCP server address");
	}
	const baseUrl = `http://127.0.0.1:${address.port}`;
	try {
		await fn({ baseUrl, requests });
	} finally {
		await new Promise((resolvePromise) => server.close(resolvePromise));
	}
}

function withWakeSpy(fn) {
	const dir = mkdtempSync(join(tmpdir(), "paab-poll-test-"));
	const logPath = join(dir, "wake-calls.log");
	const spyPath = join(dir, "wake-spy.sh");
	writeFileSync(
		spyPath,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\n`,
		"utf8",
	);
	chmodSync(spyPath, 0o755);
	return fn({ dir, logPath, spyPath }).finally(() => {
		rmSync(dir, { recursive: true, force: true });
	});
}

function baseEnv(overrides = {}) {
	return {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		...overrides,
	};
}

test("poll-unread.sh exits 0 quietly without waking when unread is 0", async () => {
	await withWakeSpy(async ({ logPath, spyPath }) => {
		await withServer(
			(_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end('{"unread":0}');
			},
			async ({ baseUrl, requests }) => {
				const result = await runCommand(
					pollScript,
					[],
					baseEnv({
						PAAB_URL: baseUrl,
						PAAB_UNREAD_TOKEN: "tok_zero_check",
						PAAB_WAKE_CMD: spyPath,
					}),
				);
				assert.equal(result.code, 0);
				assert.equal(result.stdout, "");
				assert.equal(result.stderr, "");
				assert.equal(requests.length, 1);
				assert.equal(requests[0].method, "GET");
				assert.equal(requests[0].url, "/unread");
				assert.equal(requests[0].authorization, "Bearer tok_zero_check");
				assert.equal(existsSync(logPath), false);
			},
		);
	});
});

test("poll-unread.sh invokes PAAB_WAKE_CMD once with unread count when unread > 0", async () => {
	await withWakeSpy(async ({ dir, logPath, spyPath }) => {
		await withServer(
			(_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end('{"unread": 3}');
			},
			async ({ baseUrl }) => {
				const result = await runCommand(
					pollScript,
					[],
					baseEnv({
						PAAB_URL: `${baseUrl}/`,
						PAAB_UNREAD_TOKEN: "tok_three",
						PAAB_WAKE_CMD: spyPath,
					}),
					dir,
				);
				assert.equal(result.code, 0);
				assert.equal(readFileSync(logPath, "utf8"), "3\n");
			},
		);
	});

	const failDir = mkdtempSync(join(tmpdir(), "paab-wake-fail-"));
	const failWake = join(failDir, "fail-wake.sh");
	writeFileSync(failWake, "#!/bin/sh\nexit 7\n", "utf8");
	chmodSync(failWake, 0o755);
	try {
		await withServer(
			(_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end('{"unread": 5}');
			},
			async ({ baseUrl }) => {
				const result = await runCommand(
					pollScript,
					[],
					baseEnv({
						PAAB_URL: baseUrl,
						PAAB_UNREAD_TOKEN: "tok_fail_wake",
						PAAB_WAKE_CMD: failWake,
					}),
				);
				assert.equal(result.code, 7);
			},
		);
	} finally {
		rmSync(failDir, { recursive: true, force: true });
	}
});

test("poll-unread.sh resolves default wake-agent.sh regardless of working directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "paab-cwd-test-"));
	try {
		await withServer(
			(_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end('{"unread":2}');
			},
			async ({ baseUrl }) => {
				const result = await runCommand(
					pollScript,
					[],
					baseEnv({
						PAAB_UNREAD_URL: `${baseUrl}/unread`,
						PAAB_UNREAD_TOKEN: "tok_cwd",
					}),
					dir,
				);
				assert.equal(result.code, 0);
				assert.match(result.stdout, /2 unread message\(s\) waiting/);
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("poll-unread.sh reads and trims token from PAAB_UNREAD_TOKEN_FILE", async () => {
	await withWakeSpy(async ({ dir, logPath, spyPath }) => {
		const tokenFile = join(dir, "token.txt");
		writeFileSync(tokenFile, "tok_from_file\r\n", "utf8");
		chmodSync(tokenFile, 0o600);

		await withServer(
			(_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end('{"unread":1}');
			},
			async ({ baseUrl, requests }) => {
				const result = await runCommand(
					pollScript,
					[],
					baseEnv({
						PAAB_URL: baseUrl,
						PAAB_UNREAD_TOKEN_FILE: tokenFile,
						PAAB_WAKE_CMD: spyPath,
					}),
				);
				assert.equal(result.code, 0);
				assert.equal(requests[0].authorization, "Bearer tok_from_file");
				assert.equal(readFileSync(logPath, "utf8"), "1\n");
			},
		);
	});
});

test("poll-unread.sh fails on HTTP 401 and 500 without waking or leaking the token", async () => {
	const secretToken = "paab_super_secret_token_999";
	for (const status of [401, 500]) {
		await withWakeSpy(async ({ logPath, spyPath }) => {
			await withServer(
				(_req, res) => {
					res.writeHead(status, { "Content-Type": "text/plain" });
					res.end(status === 401 ? "Unauthorized" : "Internal Server Error");
				},
				async ({ baseUrl }) => {
					const result = await runCommand(
						pollScript,
						[],
						baseEnv({
							PAAB_URL: baseUrl,
							PAAB_UNREAD_TOKEN: secretToken,
							PAAB_WAKE_CMD: spyPath,
						}),
					);
					assert.notEqual(result.code, 0);
					assert.equal(result.stdout.includes(secretToken), false);
					assert.equal(result.stderr.includes(secretToken), false);
					assert.equal(existsSync(logPath), false);
				},
			);
		});
	}
});

test("poll-unread.sh rejects malformed, negative, and non-integer payloads without waking", async () => {
	const badBodies = [
		"not json",
		"{}",
		'{"unread":-1}',
		'{"unread":1.5}',
		'{"unread":"3"}',
		'{"unread":null}',
		'{"unread":3,"extra":1}',
		'{"unread":01}',
	];

	for (const body of badBodies) {
		await withWakeSpy(async ({ logPath, spyPath }) => {
			await withServer(
				(_req, res) => {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(body);
				},
				async ({ baseUrl }) => {
					const result = await runCommand(
						pollScript,
						[],
						baseEnv({
							PAAB_URL: baseUrl,
							PAAB_UNREAD_TOKEN: "tok_bad_body",
							PAAB_WAKE_CMD: spyPath,
						}),
					);
					assert.notEqual(result.code, 0, `expected failure for body: ${body}`);
					assert.equal(existsSync(logPath), false);
				},
			);
		});
	}
});

test("poll-unread.sh exits non-zero when URL or token is missing without invoking wake command", async () => {
	await withWakeSpy(async ({ dir, logPath, spyPath }) => {
		const missingUrl = await runCommand(
			pollScript,
			[],
			baseEnv({
				PAAB_UNREAD_TOKEN: "tok_no_url",
				PAAB_WAKE_CMD: spyPath,
			}),
		);
		assert.notEqual(missingUrl.code, 0);
		assert.equal(existsSync(logPath), false);

		const missingToken = await runCommand(
			pollScript,
			[],
			baseEnv({
				PAAB_URL: "http://127.0.0.1:1",
				PAAB_WAKE_CMD: spyPath,
			}),
		);
		assert.notEqual(missingToken.code, 0);
		assert.equal(existsSync(logPath), false);

		const missingTokenFile = await runCommand(
			pollScript,
			[],
			baseEnv({
				PAAB_URL: "http://127.0.0.1:1",
				PAAB_UNREAD_TOKEN_FILE: join(dir, "does-not-exist"),
				PAAB_WAKE_CMD: spyPath,
			}),
		);
		assert.notEqual(missingTokenFile.code, 0);
		assert.equal(existsSync(logPath), false);
	});
});

test("examples/wake-agent.sh and examples/poll-unread.sh are executable and wake-agent.sh handles valid and missing args", async () => {
	assert.notEqual(statSync(pollScript).mode & 0o111, 0);
	assert.notEqual(statSync(wakeScript).mode & 0o111, 0);

	const ok = await runCommand(wakeScript, ["3"], baseEnv());
	assert.equal(ok.code, 0);
	assert.match(ok.stdout, /3 unread message\(s\) waiting/);

	const missingArg = await runCommand(wakeScript, [], baseEnv());
	assert.notEqual(missingArg.code, 0);
	assert.match(missingArg.stderr, /Usage:/);
});
