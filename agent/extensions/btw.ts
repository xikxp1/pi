/**
 * /btw — ask a side question that sees the current conversation but never joins it.
 *
 * The answer is stored as a custom entry, which pi excludes from LLM context, so
 * the main conversation continues as if the detour never happened.
 */

import type { AssistantMessage, Context, Message, TextContent } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	buildSessionContext,
	getMarkdownTheme,
	keyHint,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

const BTW_ENTRY = "btw";
const COLLAPSED_ANSWER_LINES = 8;

const SIDE_NOTE = [
	"",
	"The user has stepped aside from the main task to ask a side question.",
	"Answer the question directly using the conversation above as background.",
	"You have no tools here, so answer from what is already in context.",
	"Do not resume, restate, or act on the main task — the user will return to it themselves.",
].join("\n");

interface BtwEntryData {
	question: string;
	answer: string;
	model: string;
	/** Starts a new side thread: earlier btw turns are not context for this one. */
	fresh: boolean;
}

// Replayed history only needs role and content, but AssistantMessage demands the
// full accounting shape. Real numbers are not worth persisting to restate a turn.
const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export default function (pi: ExtensionAPI) {
	// Side-thread turns, so follow-up /btw calls build on each other.
	let sideTurns: Array<{ question: string; answer: string }> = [];

	const userTurn = (text: string): Message => ({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	});

	const assistantTurn = (text: string, model: NonNullable<ExtensionCommandContext["model"]>): Message => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: NO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	});

	const answerText = (message: AssistantMessage): string =>
		message.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();

	pi.on("session_start", (_event, ctx) => {
		sideTurns = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== BTW_ENTRY) continue;
			const data = entry.data as BtwEntryData | undefined;
			if (!data) continue;
			if (data.fresh) sideTurns = [];
			sideTurns.push({ question: data.question, answer: data.answer });
		}
	});

	pi.registerEntryRenderer<BtwEntryData>(BTW_ENTRY, (entry, { expanded }, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const data = entry.data;
		if (!data) return box;

		box.addChild(
			new Text(`${theme.fg("customMessageLabel", theme.bold("btw"))} ${theme.fg("muted", data.question)}`, 0, 0),
		);

		const lines = data.answer.split("\n");
		const clipped = !expanded && lines.length > COLLAPSED_ANSWER_LINES;
		const shown = clipped ? lines.slice(0, COLLAPSED_ANSWER_LINES).join("\n") : data.answer;
		box.addChild(new Markdown(shown, 0, 0, getMarkdownTheme()));

		if (clipped) {
			const hidden = lines.length - COLLAPSED_ANSWER_LINES;
			box.addChild(new Text(theme.fg("dim", `+${hidden} more · ${keyHint("app.tools.expand", "to expand")}`), 0, 0));
		}
		return box;
	});

	pi.registerCommand("btw", {
		description: "Ask a side question with the current context, leaving the conversation untouched",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			// The side call reuses the provider the agent is streaming through, and
			// some providers keep per-query state that a concurrent call would corrupt.
			if (!ctx.isIdle()) {
				ctx.ui.notify("/btw is unavailable while the agent is working", "warning");
				return;
			}

			let question = args.trim();
			const fresh = question === "--new" || question.startsWith("--new ");
			if (fresh) question = question.slice("--new".length).trim();
			if (!question) question = (await ctx.ui.input("Side question:", "ask anything"))?.trim() ?? "";
			if (!question) return;

			if (fresh) sideTurns = [];

			const model = ctx.model;
			const result = await ctx.ui.custom<AssistantMessage | Error | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Asking ${model.id} on the side...`);
				loader.onAbort = () => done(null);

				const ask = async (): Promise<AssistantMessage> => {
					const provider = ctx.modelRegistry.getProvider(model.provider);
					if (!provider) throw new Error(`Unknown provider: ${model.provider}`);
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok) throw new Error(auth.error);

					// Re-read the main context on every call so a side thread opened
					// earlier still sees whatever the main conversation has since done.
					const main = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
					const history = sideTurns.flatMap((turn) => [userTurn(turn.question), assistantTurn(turn.answer, model)]);
					const context: Context = {
						systemPrompt: `${ctx.getSystemPrompt()}\n${SIDE_NOTE}`,
						messages: [...main.messages, ...history, userTurn(question)] as Context["messages"],
					};

					const thinking = ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel;
					return provider
						.streamSimple(model, context, {
							apiKey: auth.apiKey,
							headers: auth.headers,
							env: auth.env,
							signal: loader.signal,
							reasoning: model.reasoning ? thinking : undefined,
						})
						.result();
				};

				ask()
					.then(done)
					.catch((error) => done(error instanceof Error ? error : new Error(String(error))));
				return loader;
			});

			if (result === null || result === undefined) return;
			if (result instanceof Error) {
				ctx.ui.notify(`/btw failed: ${result.message}`, "error");
				return;
			}
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				ctx.ui.notify(`/btw ${result.stopReason}: ${result.errorMessage ?? "no response"}`, "error");
				return;
			}

			const answer = answerText(result);
			if (!answer) {
				ctx.ui.notify("/btw got an empty response", "warning");
				return;
			}

			sideTurns.push({ question, answer });
			pi.appendEntry<BtwEntryData>(BTW_ENTRY, { question, answer, model: model.id, fresh });
		},
	});
}
