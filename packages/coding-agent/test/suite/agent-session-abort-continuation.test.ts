import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

describe("AgentSession cancellation across recovery boundaries", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("preserves an error while extension abort stops retry and late follow-ups, including a custom mode handler", async () => {
		const errorMessage = "This content was flagged for possible cybersecurity risk. Upstream network error 503";
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event, ctx) => {
						if (event.message.role === "assistant" && event.message.stopReason === "error") ctx.abort();
					});
					pi.on("agent_end", (event) => {
						const last = event.messages.at(-1);
						if (last?.role !== "assistant" || last.stopReason !== "error") return;
						pi.sendUserMessage("late queued follow-up", { deliverAs: "followUp" });
						pi.sendMessage(
							{ customType: "late", content: "late custom turn", display: false },
							{ triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		const customAbort = vi.fn();
		await harness.session.bindExtensions({ abortHandler: customAbort });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("first request");

		expect(customAbort).toHaveBeenCalledOnce();
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([false]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		const persisted = harness.sessionManager.getBranch().filter((entry) => entry.type === "message");
		expect(persisted.at(-1)?.message).toMatchObject({ role: "assistant", stopReason: "error", errorMessage });

		// Only an explicit new prompt resets cancellation; the recorded error remains.
		harness.setResponses([fauxAssistantMessage("recovered")]);
		await harness.session.prompt("explicit recovery");
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["first request", "explicit recovery"]);
		expect(harness.session.getLastAssistantText()).toBe("recovered");
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.errorMessage === errorMessage,
				),
		).toBe(true);
	});

	it("does not reset away a before_agent_start abort", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event, ctx) => {
						if (event.prompt === "cancel before request") ctx.abort();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("accepted later")]);
		await harness.session.prompt("cancel before request");
		expect(harness.faux.state.callCount).toBe(0);
		await harness.session.prompt("new explicit request");
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toEqual(["new explicit request"]);
	});

	it("does not erase an input-handler abort during prompt preflight", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event, ctx) => {
						if (event.text === "cancel in input") ctx.abort();
						return { action: "continue" };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("cancel in input");
		expect(harness.faux.state.callCount).toBe(0);
		await harness.session.prompt("accepted");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("keeps ordinary transient retry working when no cancellation occurs", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "network error 503" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("retry this request");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end").at(-1)?.success).toBe(true);
	});

	it("cancels before retry sleep is installed and discards subsequently queued messages", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "network error 503" })]);
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				void harness.session.abort();
				harness.session.agent.followUp({
					role: "user",
					content: [{ type: "text", text: "late direct queue" }],
					timestamp: Date.now(),
				});
			}
		});
		await harness.session.prompt("cancel at retry start");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("cancels while retry backoff is awaited and allows a later explicit prompt", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "network error 503" })]);
		let markRetryStart = () => {};
		const retryStart = new Promise<void>((resolve) => {
			markRetryStart = resolve;
		});
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") markRetryStart();
		});
		const run = harness.session.prompt("wait for retry");
		await retryStart;
		await harness.session.followUp("queued before cancellation");
		await harness.session.abort();
		await run;
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.eventsOfType("auto_retry_end").at(-1)?.finalError).toBe("Retry cancelled");
		harness.setResponses([fauxAssistantMessage("next run")]);
		await harness.session.prompt("explicit next run");
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["wait for retry", "explicit next run"]);
	});

	it("does not begin automatic compaction after cancellation during summarization auth", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed seed response")]);
		await harness.session.prompt("seed history");
		let markAuth = () => {};
		let releaseAuth = () => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuth = resolve;
		});
		const authReleased = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		const getAuth = harness.session.modelRuntime.getAuth.bind(harness.session.modelRuntime);
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (...args) => {
			markAuth();
			await authReleased;
			return getAuth(...args);
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("unexpected summary"),
		]);
		const run = harness.session.prompt("x".repeat(5000));
		await authStarted;
		const aborted = harness.session.abort();
		releaseAuth();
		await Promise.all([run, aborted]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
	});

	it("stops automatic compaction at its start event before another provider request", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed seed response")]);
		await harness.session.prompt("seed history");
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") void harness.session.abort();
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("unexpected summary"),
		]);
		await harness.session.prompt("x".repeat(5000));
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, willRetry: false });
		expect(harness.session.isIdle).toBe(true);
	});

	it("does not continue after cancellation while an automatic compaction hook is awaited", async () => {
		let markCompaction = () => {};
		let releaseCompaction = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompaction = resolve;
		});
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompaction();
						await compactionReleased;
						return {
							compaction: {
								summary: "cancelled summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed seed response")]);
		await harness.session.prompt("seed history");
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" })]);
		const run = harness.session.prompt("x".repeat(5000));
		await compactionStarted;
		const aborted = harness.session.abort();
		releaseCompaction();
		await Promise.all([run, aborted]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, willRetry: false });
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});
});
