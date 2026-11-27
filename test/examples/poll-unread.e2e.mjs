import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const pollScript = path.join(repoRoot, "examples/poll-unread/poll-unread.sh");

/**
 * Starts a local HTTP server implementing the exact `GET /unread` contract
 * with programmable response behavior for failure and edge-case testing.
 */
async function startMockUnreadServer(expectedToken) {
	let mode = { kind: "count", unread: 0 };
	const requests = [];

	const server = http.createServer((req, res) => {
		requests.push({
			method: req.method ?? "",
			url: req.url ?? "",
			authorization: req.headers.authorization ?? "",
		});

		if (req.url !== "/unread") {
			res.writeHead(404, { "Cache-Control": "no-store" });
			res.end("Not Found");
			return;
		}

		if (req.method !== "GET") {
			res.writeHead(405, {
				Allow: "GET",
				"Cache-Control": "no-store",
			});
			res.end("Method Not Allowed");
			return;
		}

		if (mode.kind === "status") {
			res.writeHead(
				mode.status,
				mode.headers ?? { "Cache-Control": "no-store" },
			);
			res.end(mode.body ?? "");
			return;
		}

		if (req.headers.authorization !== `Bearer ${expectedToken}`) {
			res.writeHead(401, {
				"WWW-Authenticate": "Bearer",
				"Cache-Control": "no-store",
			});
			res.end();
			return;
		}

		if (mode.kind === "raw") {
			res.writeHead(200, {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "no-store",
			});
			res.end(mode.body);
			return;
		}

		res.writeHead(200, {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		});
		res.end(JSON.stringify({ unread: mode.unread }));
	});

	await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("failed to bind mock unread server");
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		setCount(unread) {
			mode = { kind: "count", unread };
		},
		setRawBody(body) {
			mode = { kind: "raw", body };
		},
		setStatus(status, body = "", headers = undefined) {
			mode = { kind: "status", status, body, headers };
		},
		async close() {
			await new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

function makeTempDir() {
	return mkdtempSync(path.join(tmpdir(), "paab-poll-unread-"));
}

function createRecorderWakeScript(
	dir,
	{ exitCode = 0, name = "wake-record.sh" } = {},
) {
	const logFile = path.join(dir, `${name}.log`);
	const scriptPath = path.join(dir, name);
	writeFileSync(
		scriptPath,
		[
			"#!/bin/sh",
			"set -eu",
			`printf 'arg1=%s arg2=%s env_cur=%s env_prev=%s\\n' "$1" "$2" "$PAAB_UNREAD_COUNT" "$PAAB_PREV_UNREAD_COUNT" >> "${logFile}"`,
			`exit ${exitCode}`,
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(scriptPath, 0o755);
	return {
		scriptPath,
		logFile,
		readCalls() {
			if (!existsSync(logFile)) return [];
			const content = readFileSync(logFile, "utf8").trim();
			return content === "" ? [] : content.split("\n");
		},
	};
}

function runPoll(env) {
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/sh", [pollScript], {
			env: {
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => {
			resolve({ status, stdout, stderr });
		});
	});
}

function readState(stateFile) {
	const raw = readFileSync(stateFile, "utf8").trim();
	const parts = raw.split(" ");
	assert.equal(parts.length, 2, `expected '<count> <timestamp>', got: ${raw}`);
	assert.match(parts[0], /^(0|[1-9][0-9]*)$/);
	assert.match(parts[1], /^(0|[1-9][0-9]*)$/);
	return {
		raw,
		count: Number(parts[0]),
		lastWake: Number(parts[1]),
	};
}

function createFakeDateBin(dir, initialEpoch) {
	const binDir = path.join(dir, "fake-date-bin");
	const epochFile = path.join(dir, "fake-epoch.txt");
	const dateShim = path.join(binDir, "date");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(epochFile, `${initialEpoch}\n`, "utf8");
	writeFileSync(
		dateShim,
		[
			"#!/bin/sh",
			"set -eu",
			'if [ "$#" -eq 1 ] && [ "$1" = "+%s" ]; then',
			`	cat -- "${epochFile}"`,
			"	exit 0",
			"fi",
			"exit 1",
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(dateShim, 0o755);
	return {
		binDir,
		setEpoch(epoch) {
			writeFileSync(epochFile, `${epoch}\n`, "utf8");
		},
	};
}

test("state transitions: 0->0, 0->2, 2->2, 2->1, 1->1, 1->3, 3->0, 0->1 and trailing slash URL", async (t) => {
	const token = "unread-token-lifecycle";
	const server = await startMockUnreadServer(token);
	const dir = makeTempDir();
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const stateFile = path.join(dir, "state/unread-count");
	const wake = createRecorderWakeScript(dir);
	const baseEnv = {
		HOME: dir,
		PAAB_URL: `${server.baseUrl}///`,
		PAAB_UNREAD_TOKEN: token,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: wake.scriptPath,
	};

	// 0 -> 0: does not wake
	server.setCount(0);
	let res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), []);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "0 0");
	assert.equal(server.requests.at(-1)?.url, "/unread");

	// 0 -> 2: wakes once with (2, 0) and env vars
	server.setCount(2);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), ["arg1=2 arg2=0 env_cur=2 env_prev=0"]);
	const stateAfter2 = readState(stateFile);
	assert.equal(stateAfter2.count, 2);
	assert.ok(stateAfter2.lastWake > 0);

	// 2 -> 2: unchanged positive count still wakes with (2, 2)
	server.setCount(2);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), [
		"arg1=2 arg2=0 env_cur=2 env_prev=0",
		"arg1=2 arg2=2 env_cur=2 env_prev=2",
	]);
	const stateAfter2Again = readState(stateFile);
	assert.equal(stateAfter2Again.count, 2);
	assert.ok(stateAfter2Again.lastWake >= stateAfter2.lastWake);

	// 2 -> 1: smaller positive count still wakes with (1, 2)
	server.setCount(1);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), [
		"arg1=2 arg2=0 env_cur=2 env_prev=0",
		"arg1=2 arg2=2 env_cur=2 env_prev=2",
		"arg1=1 arg2=2 env_cur=1 env_prev=2",
	]);
	assert.equal(readState(stateFile).count, 1);

	// 1 -> 1: simulates 1 -> read to 0 -> new message arrives (1) before next poll
	server.setCount(1);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), [
		"arg1=2 arg2=0 env_cur=2 env_prev=0",
		"arg1=2 arg2=2 env_cur=2 env_prev=2",
		"arg1=1 arg2=2 env_cur=1 env_prev=2",
		"arg1=1 arg2=1 env_cur=1 env_prev=1",
	]);
	assert.equal(readState(stateFile).count, 1);

	// 1 -> 3: wakes with (3, 1)
	server.setCount(3);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), [
		"arg1=2 arg2=0 env_cur=2 env_prev=0",
		"arg1=2 arg2=2 env_cur=2 env_prev=2",
		"arg1=1 arg2=2 env_cur=1 env_prev=2",
		"arg1=1 arg2=1 env_cur=1 env_prev=1",
		"arg1=3 arg2=1 env_cur=3 env_prev=1",
	]);
	assert.equal(readState(stateFile).count, 3);

	// 3 -> 0: does not wake, resets state to 0 0
	server.setCount(0);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(wake.readCalls().length, 5);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "0 0");

	// 0 -> 1: wakes again with (1, 0)
	server.setCount(1);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), [
		"arg1=2 arg2=0 env_cur=2 env_prev=0",
		"arg1=2 arg2=2 env_cur=2 env_prev=2",
		"arg1=1 arg2=2 env_cur=1 env_prev=2",
		"arg1=1 arg2=1 env_cur=1 env_prev=1",
		"arg1=3 arg2=1 env_cur=3 env_prev=1",
		"arg1=1 arg2=0 env_cur=1 env_prev=0",
	]);
	const stateAfterFinal1 = readState(stateFile);
	assert.equal(stateAfterFinal1.count, 1);
	assert.ok(stateAfterFinal1.lastWake > 0);
});

test("PAAB_WAKE_COOLDOWN_SECONDS throttles repeated wakes until expiry, unread reset, or clock rollback", async (t) => {
	const token = "unread-token-cooldown";
	const server = await startMockUnreadServer(token);
	const dir = makeTempDir();
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const stateFile = path.join(dir, "state/unread-count");
	const wake = createRecorderWakeScript(dir);
	const failingWake = createRecorderWakeScript(dir, {
		exitCode: 1,
		name: "failing-wake.sh",
	});
	const fakeDate = createFakeDateBin(dir, 1000);
	const baseEnv = {
		HOME: dir,
		PATH: `${fakeDate.binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN: token,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: wake.scriptPath,
		PAAB_WAKE_COOLDOWN_SECONDS: "60",
	};

	// t=1000, 0 -> 1: wakes immediately and records last_wake=1000
	server.setCount(1);
	let res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), ["arg1=1 arg2=0 env_cur=1 env_prev=0"]);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "1 1000");

	// t=1059 (59s < 60s), 1 -> 1: suppressed, last_wake preserved
	fakeDate.setEpoch(1059);
	server.setCount(1);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(wake.readCalls().length, 1);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "1 1000");

	// t=1059 (still in cooldown), 1 -> 2: suppressed, count updated but last_wake not extended
	server.setCount(2);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(wake.readCalls().length, 1);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "2 1000");

	// t=1060 (60s >= 60s), 2 -> 2: cooldown expired, wakes again
	fakeDate.setEpoch(1060);
	server.setCount(2);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), [
		"arg1=1 arg2=0 env_cur=1 env_prev=0",
		"arg1=2 arg2=2 env_cur=2 env_prev=2",
	]);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "2 1060");

	// t=1070, 2 -> 0: resets state to 0 0
	fakeDate.setEpoch(1070);
	server.setCount(0);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(wake.readCalls().length, 2);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "0 0");

	// t=1075 (15s after last wake, but unread dropped to 0): wakes immediately
	fakeDate.setEpoch(1075);
	server.setCount(1);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), [
		"arg1=1 arg2=0 env_cur=1 env_prev=0",
		"arg1=2 arg2=2 env_cur=2 env_prev=2",
		"arg1=1 arg2=0 env_cur=1 env_prev=0",
	]);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "1 1075");

	// Clock rollback (t=1000 < last_wake=1075): wakes instead of getting stuck
	fakeDate.setEpoch(1000);
	server.setCount(1);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), [
		"arg1=1 arg2=0 env_cur=1 env_prev=0",
		"arg1=2 arg2=2 env_cur=2 env_prev=2",
		"arg1=1 arg2=0 env_cur=1 env_prev=0",
		"arg1=1 arg2=1 env_cur=1 env_prev=1",
	]);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "1 1000");

	// Failed wake does not start cooldown: next poll retries immediately
	fakeDate.setEpoch(2000);
	server.setCount(0);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "0 0");

	server.setCount(1);
	res = await runPoll({
		...baseEnv,
		PAAB_WAKE_SCRIPT: failingWake.scriptPath,
	});
	assert.notEqual(res.status, 0);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "0 0");

	fakeDate.setEpoch(2001);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(wake.readCalls().length, 5);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "1 2001");
});

test("PAAB_WAKE_COOLDOWN_SECONDS works with system date and resets when unread drops to 0", async (t) => {
	const token = "unread-token-real-date";
	const server = await startMockUnreadServer(token);
	const dir = makeTempDir();
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const stateFile = path.join(dir, "unread-count");
	const wake = createRecorderWakeScript(dir);
	const baseEnv = {
		HOME: dir,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN: token,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: wake.scriptPath,
		PAAB_WAKE_COOLDOWN_SECONDS: "3600",
	};

	server.setCount(1);
	let res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(wake.readCalls().length, 1);
	const firstState = readState(stateFile);
	assert.equal(firstState.count, 1);
	assert.ok(firstState.lastWake > 0);

	// Immediate second poll is suppressed by real system clock cooldown
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(wake.readCalls().length, 1);
	assert.equal(readFileSync(stateFile, "utf8").trim(), firstState.raw);

	// Unread drops to 0 -> resets state, so subsequent 0 -> 1 wakes immediately
	server.setCount(0);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(readFileSync(stateFile, "utf8").trim(), "0 0");

	server.setCount(1);
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(wake.readCalls().length, 2);
});

test("default wake.sh runs when PAAB_WAKE_SCRIPT is unset", async (t) => {
	const token = "unread-token-default-wake";
	const server = await startMockUnreadServer(token);
	const dir = makeTempDir();
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	server.setCount(2);
	const res = await runPoll({
		HOME: dir,
		XDG_STATE_HOME: path.join(dir, "xdg-state"),
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN: token,
	});
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stdout, "[paab] new unread messages: 2 (previous: 0)\n");
	const state = readState(path.join(dir, "xdg-state/paab/unread-count"));
	assert.equal(state.count, 2);
	assert.ok(state.lastWake > 0);
});

test("network errors, non-200 HTTP, and malformed JSON preserve state and recover on next poll", async (t) => {
	const token = "unread-token-errors";
	const server = await startMockUnreadServer(token);
	const dir = makeTempDir();
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const stateFile = path.join(dir, "unread-count");
	const wake = createRecorderWakeScript(dir);
	const baseEnv = {
		HOME: dir,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN: token,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: wake.scriptPath,
	};

	// Establish initial state = "1 <timestamp>"
	server.setCount(1);
	let res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(wake.readCalls().length, 1);
	const initialState = readState(stateFile);
	assert.equal(initialState.count, 1);
	assert.ok(initialState.lastWake > 0);

	// Unreachable server (bind and immediately close an ephemeral port)
	const deadServer = http.createServer();
	await new Promise((resolve) => deadServer.listen(0, "127.0.0.1", resolve));
	const deadPort = deadServer.address().port;
	await new Promise((resolve) => deadServer.close(resolve));

	res = await runPoll({ ...baseEnv, PAAB_URL: `http://127.0.0.1:${deadPort}` });
	assert.notEqual(res.status, 0);
	assert.notEqual(res.stderr.trim(), "");
	assert.equal(wake.readCalls().length, 1);
	assert.equal(readFileSync(stateFile, "utf8").trim(), initialState.raw);

	// HTTP 500
	server.setStatus(500, "Internal Server Error");
	res = await runPoll(baseEnv);
	assert.notEqual(res.status, 0);
	assert.equal(wake.readCalls().length, 1);
	assert.equal(readFileSync(stateFile, "utf8").trim(), initialState.raw);

	// HTTP 401 (wrong token)
	server.setCount(5);
	res = await runPoll({ ...baseEnv, PAAB_UNREAD_TOKEN: "wrong-token" });
	assert.notEqual(res.status, 0);
	assert.equal(wake.readCalls().length, 1);
	assert.equal(readFileSync(stateFile, "utf8").trim(), initialState.raw);

	// HTTP 403 (suspended agent)
	server.setStatus(403, "agent suspended");
	res = await runPoll(baseEnv);
	assert.notEqual(res.status, 0);
	assert.equal(wake.readCalls().length, 1);
	assert.equal(readFileSync(stateFile, "utf8").trim(), initialState.raw);

	// HTTP 302 redirect (even with JSON body) must be rejected
	server.setStatus(302, '{"unread": 9}', {
		Location: `${server.baseUrl}/other`,
		"Cache-Control": "no-store",
	});
	res = await runPoll(baseEnv);
	assert.notEqual(res.status, 0);
	assert.equal(wake.readCalls().length, 1);
	assert.equal(readFileSync(stateFile, "utf8").trim(), initialState.raw);

	// Malformed JSON variants
	const malformedBodies = [
		"",
		"{}",
		'{"unread": -1}',
		'{"unread": "3"}',
		'{"unread": 03}',
		'{"unread": 3.5}',
		'{"unread": 3, "extra": 1}',
		'{"other": 3}',
		'{"un read": 3}',
		'{"unread": 1 2}',
		'{"unread": 3}{"unread": 4}',
		"<html>login</html>",
	];
	for (const body of malformedBodies) {
		server.setRawBody(body);
		res = await runPoll(baseEnv);
		assert.notEqual(
			res.status,
			0,
			`expected failure for body: ${JSON.stringify(body)}`,
		);
		assert.equal(wake.readCalls().length, 1);
		assert.equal(readFileSync(stateFile, "utf8").trim(), initialState.raw);
	}

	// Recovers immediately on the next valid poll (including multi-line whitespace JSON)
	server.setRawBody('{\n  "unread" : 4\n}\r\n');
	res = await runPoll(baseEnv);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), [
		"arg1=1 arg2=0 env_cur=1 env_prev=0",
		"arg1=4 arg2=1 env_cur=4 env_prev=1",
	]);
	const recoveredState = readState(stateFile);
	assert.equal(recoveredState.count, 4);
	assert.ok(recoveredState.lastWake >= initialState.lastWake);
});

test("PAAB_UNREAD_TOKEN_FILE (chmod 600), header escaping, and token validation", async (t) => {
	// Include backslash and double quote to prove curl --config - escaping works end-to-end.
	const specialToken = 'tok\\en"with$special`chars';
	const server = await startMockUnreadServer(specialToken);
	const dir = makeTempDir();
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const tokenFile = path.join(dir, "unread-token");
	writeFileSync(tokenFile, `${specialToken}\r\n`, "utf8");
	chmodSync(tokenFile, 0o600);

	const stateFile = path.join(dir, "unread-count");
	const wake = createRecorderWakeScript(dir);

	server.setCount(2);
	let res = await runPoll({
		HOME: dir,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN_FILE: tokenFile,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: wake.scriptPath,
	});
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(wake.readCalls(), ["arg1=2 arg2=0 env_cur=2 env_prev=0"]);
	assert.equal(server.requests.at(-1)?.authorization, `Bearer ${specialToken}`);
	const persistedState = readState(stateFile);
	assert.equal(persistedState.count, 2);

	// Reject empty token file
	const emptyFile = path.join(dir, "empty-token");
	writeFileSync(emptyFile, "\r\n", "utf8");
	chmodSync(emptyFile, 0o600);
	res = await runPoll({
		HOME: dir,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN_FILE: emptyFile,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: wake.scriptPath,
	});
	assert.notEqual(res.status, 0);

	// Reject embedded newline in token file
	const multilineFile = path.join(dir, "multiline-token");
	writeFileSync(multilineFile, "line1\nline2\n", "utf8");
	chmodSync(multilineFile, 0o600);
	res = await runPoll({
		HOME: dir,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN_FILE: multilineFile,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: wake.scriptPath,
	});
	assert.notEqual(res.status, 0);

	// Reject NUL byte in token file
	const nulFile = path.join(dir, "nul-token");
	writeFileSync(nulFile, Buffer.from("abc\0def\n"));
	chmodSync(nulFile, 0o600);
	res = await runPoll({
		HOME: dir,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN_FILE: nulFile,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: wake.scriptPath,
	});
	assert.notEqual(res.status, 0);
	assert.equal(readFileSync(stateFile, "utf8").trim(), persistedState.raw);
});

test("custom PAAB_WAKE_SCRIPT failure leaves state unchanged and retries on next run", async (t) => {
	const token = "unread-token-wake-retry";
	const server = await startMockUnreadServer(token);
	const dir = makeTempDir();
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const stateFile = path.join(dir, "unread-count");
	const failingWake = createRecorderWakeScript(dir, {
		exitCode: 42,
		name: "failing-wake.sh",
	});
	const okWake = createRecorderWakeScript(dir, {
		exitCode: 0,
		name: "ok-wake.sh",
	});
	const nonExecWake = path.join(dir, "non-exec-wake.sh");
	writeFileSync(nonExecWake, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(nonExecWake, 0o644);

	server.setCount(2);

	// Non-executable wake script fails and does not create state file
	let res = await runPoll({
		HOME: dir,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN: token,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: nonExecWake,
	});
	assert.notEqual(res.status, 0);
	assert.match(res.stderr, /not an executable/);
	assert.equal(existsSync(stateFile), false);

	// Failing wake script leaves state file unchanged
	res = await runPoll({
		HOME: dir,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN: token,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: failingWake.scriptPath,
	});
	assert.notEqual(res.status, 0);
	assert.deepEqual(failingWake.readCalls(), [
		"arg1=2 arg2=0 env_cur=2 env_prev=0",
	]);
	assert.equal(existsSync(stateFile), false);

	// Next run with working custom wake script retries and persists state
	res = await runPoll({
		HOME: dir,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN: token,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: okWake.scriptPath,
	});
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(okWake.readCalls(), ["arg1=2 arg2=0 env_cur=2 env_prev=0"]);
	const state = readState(stateFile);
	assert.equal(state.count, 2);
	assert.ok(state.lastWake > 0);
});

test("corrupt or legacy state file and invalid numeric config handling", async (t) => {
	const token = "unread-token-edge";
	const server = await startMockUnreadServer(token);
	const dir = makeTempDir();
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const stateFile = path.join(dir, "unread-count");
	const wake = createRecorderWakeScript(dir);
	writeFileSync(stateFile, "not-a-number\n", "utf8");

	// Invalid PAAB_CURL_TIMEOUT rejected without waking or modifying state
	server.setCount(1);
	for (const badTimeout of ["0", "-5", "abc", "05"]) {
		const badRes = await runPoll({
			HOME: dir,
			PAAB_URL: server.baseUrl,
			PAAB_UNREAD_TOKEN: token,
			PAAB_STATE_FILE: stateFile,
			PAAB_WAKE_SCRIPT: wake.scriptPath,
			PAAB_CURL_TIMEOUT: badTimeout,
		});
		assert.notEqual(
			badRes.status,
			0,
			`expected failure for timeout ${badTimeout}`,
		);
	}

	// Invalid PAAB_WAKE_COOLDOWN_SECONDS rejected without waking or modifying state
	for (const badCooldown of [
		"-1",
		"-5",
		"abc",
		"05",
		"00",
		"1.5",
		"10s",
		" 5",
	]) {
		const badRes = await runPoll({
			HOME: dir,
			PAAB_URL: server.baseUrl,
			PAAB_UNREAD_TOKEN: token,
			PAAB_STATE_FILE: stateFile,
			PAAB_WAKE_SCRIPT: wake.scriptPath,
			PAAB_WAKE_COOLDOWN_SECONDS: badCooldown,
		});
		assert.notEqual(
			badRes.status,
			0,
			`expected failure for cooldown ${JSON.stringify(badCooldown)}`,
		);
		assert.match(badRes.stderr, /PAAB_WAKE_COOLDOWN_SECONDS/);
	}
	assert.deepEqual(wake.readCalls(), []);
	assert.equal(readFileSync(stateFile, "utf8"), "not-a-number\n");

	// Malformed state files default to 0 0 and are atomically repaired
	for (const corruptState of [
		"not-a-number\n",
		"* *\n",
		"0 1000\n",
		"2 abc\n",
	]) {
		writeFileSync(stateFile, corruptState, "utf8");
		const beforeCount = wake.readCalls().length;
		const res = await runPoll({
			HOME: dir,
			PAAB_URL: server.baseUrl,
			PAAB_UNREAD_TOKEN: token,
			PAAB_STATE_FILE: stateFile,
			PAAB_WAKE_SCRIPT: wake.scriptPath,
			PAAB_CURL_TIMEOUT: "5",
			PAAB_WAKE_COOLDOWN_SECONDS: "3600",
		});
		assert.equal(res.status, 0, res.stderr);
		assert.equal(wake.readCalls().length, beforeCount + 1);
		assert.equal(wake.readCalls().at(-1), "arg1=1 arg2=0 env_cur=1 env_prev=0");
		const repaired = readState(stateFile);
		assert.equal(repaired.count, 1);
		assert.ok(repaired.lastWake > 0);
	}

	// Legacy single-number state file preserves prev count and wakes immediately without cooldown
	writeFileSync(stateFile, "2\n", "utf8");
	server.setCount(2);
	const legacyRes = await runPoll({
		HOME: dir,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN: token,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: wake.scriptPath,
		PAAB_WAKE_COOLDOWN_SECONDS: "3600",
	});
	assert.equal(legacyRes.status, 0, legacyRes.stderr);
	assert.equal(wake.readCalls().at(-1), "arg1=2 arg2=2 env_cur=2 env_prev=2");
	const upgraded = readState(stateFile);
	assert.equal(upgraded.count, 2);
	assert.ok(upgraded.lastWake > 0);
});

test("bearer token is passed via curl --config - stdin and never appears in curl argv", async (t) => {
	const secretToken = "super-secret-unread-token-xyz";
	const server = await startMockUnreadServer(secretToken);
	const dir = makeTempDir();
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const whichCurl = spawnSync("/bin/sh", ["-c", "command -v curl"], {
		encoding: "utf8",
	});
	assert.equal(whichCurl.status, 0, "expected curl to be in PATH");
	const realCurl = whichCurl.stdout.trim();

	const fakeBin = path.join(dir, "bin");
	const argvLog = path.join(dir, "curl-argv.log");
	const stdinLog = path.join(dir, "curl-stdin.log");
	const stateFile = path.join(dir, "unread-count");
	const wake = createRecorderWakeScript(dir);
	const shimPath = path.join(fakeBin, "curl");

	mkdirSync(fakeBin, { recursive: true });
	writeFileSync(
		shimPath,
		[
			"#!/bin/sh",
			"set -eu",
			`printf '%s\\n' "$@" > "${argvLog}"`,
			`cat > "${stdinLog}"`,
			`exec "${realCurl}" "$@" < "${stdinLog}"`,
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(shimPath, 0o755);

	server.setCount(1);
	const res = await runPoll({
		HOME: dir,
		PATH: `${fakeBin}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
		PAAB_URL: server.baseUrl,
		PAAB_UNREAD_TOKEN: secretToken,
		PAAB_STATE_FILE: stateFile,
		PAAB_WAKE_SCRIPT: wake.scriptPath,
	});
	assert.equal(res.status, 0, res.stderr);

	const argvLines = readFileSync(argvLog, "utf8").trim().split("\n");
	assert.equal(argvLines.join(" ").includes(secretToken), false);
	assert.equal(argvLines.includes("--config"), true);
	assert.equal(argvLines.includes("-"), true);
	assert.equal(argvLines.includes("-L"), false);
	assert.equal(argvLines.includes("--location"), false);

	const stdinContent = readFileSync(stdinLog, "utf8");
	assert.equal(
		stdinContent,
		`header = "Authorization: Bearer ${secretToken}"\n`,
	);
});
