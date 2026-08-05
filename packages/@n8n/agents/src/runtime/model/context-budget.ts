import type { ToolSet } from 'ai';

import type { ContextBudgetOptions } from '../../types/sdk/agent';
import type { ContentText, Message, MessageContent } from '../../types/sdk/message';
import type { JSONValue } from '../../types/utils/json';

const APPROXIMATE_CHARS_PER_TOKEN = 4;
const MINIMUM_TURN_BUDGET_TOKENS = 128;

function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_key, nested) => {
				if (typeof nested === 'bigint') return nested.toString();
				if (typeof nested === 'function') return undefined;
				if (nested instanceof Uint8Array) return `[Uint8Array ${nested.byteLength} bytes]`;
				if (nested instanceof ArrayBuffer) return `[ArrayBuffer ${nested.byteLength} bytes]`;
				if (typeof nested === 'object' && nested !== null) {
					if (seen.has(nested)) return '[Circular]';
					seen.add(nested);
				}
				return nested;
			}) ?? String(value)
		);
	} catch {
		return String(value);
	}
}

export function estimateContextTokens(value: unknown): number {
	return Math.max(1, Math.ceil(safeStringify(value).length / APPROXIMATE_CHARS_PER_TOKEN));
}

function compactString(text: string, tokenBudget: number): string {
	const characterBudget = Math.max(96, tokenBudget * APPROXIMATE_CHARS_PER_TOKEN);
	if (text.length <= characterBudget) return text;

	const omission = '\n\n...[context compacted by n8n]...\n\n';
	const available = Math.max(32, characterBudget - omission.length);
	const headLength = Math.ceil(available * 0.6);
	const tailLength = Math.floor(available * 0.4);
	return `${text.slice(0, headLength)}${omission}${text.slice(-tailLength)}`;
}

function compactJsonValue(value: JSONValue, tokenBudget: number): JSONValue {
	const serialized = safeStringify(value);
	const estimatedTokens = estimateContextTokens(serialized);
	if (estimatedTokens <= tokenBudget) return value;

	return {
		n8n_context_compacted: true,
		originalEstimatedTokens: estimatedTokens,
		preview: compactString(serialized, Math.max(64, tokenBudget - 32)),
	};
}

function compactSettledToolCalls(message: Message, maxToolPayloadTokens: number): Message {
	let changed = false;
	const content = message.content.map((block): MessageContent => {
		if (block.type !== 'tool-call' || block.state === 'pending') return block;

		const input = compactJsonValue(block.input, maxToolPayloadTokens);
		if (block.state === 'resolved') {
			const output = compactJsonValue(block.output, maxToolPayloadTokens);
			if (input === block.input && output === block.output) return block;
			changed = true;
			return { ...block, input, output };
		}

		const error = compactString(block.error, maxToolPayloadTokens);
		if (input === block.input && error === block.error) return block;
		changed = true;
		return { ...block, input, error };
	});

	return changed ? { ...message, content } : message;
}

function compactTextBlock(block: ContentText, tokenBudget: number): ContentText {
	const text = compactString(block.text, tokenBudget);
	return text === block.text ? block : { ...block, text };
}

function compactMessageToBudget(message: Message, tokenBudget: number): Message {
	if (estimateContextTokens(message) <= tokenBudget) return message;

	const adjustableCount = message.content.filter(
		(block) =>
			block.type === 'text' ||
			block.type === 'reasoning' ||
			(block.type === 'tool-call' && block.state !== 'pending'),
	).length;
	if (adjustableCount === 0) return message;

	const perBlockBudget = Math.max(24, Math.floor(tokenBudget / adjustableCount));
	const content = message.content.map((block): MessageContent => {
		if (block.type === 'text') return compactTextBlock(block, perBlockBudget);
		if (block.type === 'reasoning') {
			return { ...block, text: compactString(block.text, perBlockBudget) };
		}
		if (block.type === 'tool-call' && block.state === 'resolved') {
			const perPayloadBudget = Math.max(24, Math.floor(perBlockBudget / 2));
			return {
				...block,
				input: compactJsonValue(block.input, perPayloadBudget),
				output: compactJsonValue(block.output, perPayloadBudget),
			};
		}
		if (block.type === 'tool-call' && block.state === 'rejected') {
			const perPayloadBudget = Math.max(24, Math.floor(perBlockBudget / 2));
			return {
				...block,
				input: compactJsonValue(block.input, perPayloadBudget),
				error: compactString(block.error, perPayloadBudget),
			};
		}
		return block;
	});
	return { ...message, content };
}

function messageTextForEmergencyFallback(message: Message): string {
	const visibleText = message.content
		.flatMap((block) => {
			if (block.type === 'text' || block.type === 'reasoning') return [block.text];
			if (block.type === 'tool-call') {
				return [
					`Tool ${block.toolName} (${block.state}) input=${safeStringify(block.input)}`,
					block.state === 'resolved'
						? `output=${safeStringify(block.output)}`
						: block.state === 'rejected'
							? `error=${block.error}`
							: '',
				];
			}
			return [];
		})
		.filter(Boolean)
		.join('\n');
	return visibleText || safeStringify(message);
}

function emergencyFallback(messages: Message[], tokenBudget: number): Message[] {
	const latestUser = [...messages].reverse().find((message) => message.role === 'user');
	const latestAssistant = [...messages]
		.reverse()
		.find((message) => message.role === 'assistant' || message.role === 'tool');
	const essentials = [latestUser, latestAssistant].filter(
		(message, index, items): message is Message =>
			message !== undefined && items.indexOf(message) === index,
	);
	if (essentials.length === 0) return [];

	const perMessageBudget = Math.max(32, Math.floor(tokenBudget / essentials.length));
	const fallback = essentials.map(
		(message): Message => ({
			...(message.id !== undefined ? { id: message.id } : {}),
			...(message.type !== undefined ? { type: message.type } : {}),
			role: message.role === 'tool' ? 'assistant' : message.role,
			...(message.name !== undefined ? { name: message.name } : {}),
			content: [
				{
					type: 'text',
					text: compactString(messageTextForEmergencyFallback(message), perMessageBudget),
				},
			],
		}),
	);
	if (estimateContextTokens(fallback) <= tokenBudget) return fallback;

	const primary = latestUser ?? latestAssistant;
	if (!primary) return [];
	return [
		{
			role: primary.role === 'tool' ? 'assistant' : primary.role,
			content: [
				{
					type: 'text',
					text: compactString(messageTextForEmergencyFallback(primary), tokenBudget),
				},
			],
		},
	];
}

function groupIntoTurns(messages: Message[]): Message[][] {
	const turns: Message[][] = [];
	let current: Message[] = [];

	for (const message of messages) {
		if (message.role === 'user' && current.length > 0) {
			turns.push(current);
			current = [];
		}
		current.push(message);
	}
	if (current.length > 0) turns.push(current);
	return turns;
}

function compactTurnToBudget(turn: Message[], tokenBudget: number): Message[] {
	if (turn.length === 0) return [];
	const perMessageBudget = Math.max(24, Math.floor(tokenBudget / turn.length));
	const compacted = turn.map((message) => compactMessageToBudget(message, perMessageBudget));
	if (estimateContextTokens(compacted) <= tokenBudget) return compacted;

	// Last-resort protection: retain the current user request and newest result rather
	// than allowing an oversized completed turn to consume the entire model context.
	const userMessage = [...turn].reverse().find((message) => message.role === 'user');
	const newestMessage = turn.at(-1);
	const essential = [userMessage, newestMessage].filter(
		(message, index, items): message is Message =>
			message !== undefined && items.indexOf(message) === index,
	);
	const essentialBudget = Math.max(24, Math.floor(tokenBudget / Math.max(1, essential.length)));
	return essential.map((message) => compactMessageToBudget(message, essentialBudget));
}

function estimateToolDefinitions(tools: ToolSet | undefined): number {
	if (!tools) return 0;
	const compactDefinitions = Object.entries(tools).map(([name, tool]) => ({
		name,
		description: 'description' in tool ? tool.description : undefined,
		inputSchema: 'inputSchema' in tool ? tool.inputSchema : undefined,
		outputSchema: 'outputSchema' in tool ? tool.outputSchema : undefined,
	}));
	return estimateContextTokens(compactDefinitions);
}

export interface BudgetAgentMessagesInput {
	messages: Message[];
	system: unknown;
	tools?: ToolSet;
	options: ContextBudgetOptions;
}

/**
 * Build a non-destructive per-call context window.
 *
 * Persistent history is left untouched. Oversized tool outputs are replaced only
 * in the prompt copy, and recent complete user turns are selected newest-first.
 */
export function budgetAgentMessages({
	messages,
	system,
	tools,
	options,
}: BudgetAgentMessagesInput): Message[] {
	const maxInputTokens = Math.max(1_024, options.maxInputTokens);
	const fixedTokens = estimateContextTokens(system) + estimateToolDefinitions(tools);
	const maxToolResultTokens = Math.max(64, options.maxToolResultTokens ?? 2_048);
	const minimumRecentTurns = Math.max(1, options.minimumRecentTurns ?? 2);

	const compacted = messages.map((message) =>
		compactSettledToolCalls(message, maxToolResultTokens),
	);
	const turns = groupIntoTurns(compacted);
	const requiredTurnCount = Math.min(minimumRecentTurns, turns.length);
	const minimumRequiredBudget = requiredTurnCount * MINIMUM_TURN_BUDGET_TOKENS;
	const messageBudget = maxInputTokens - fixedTokens;

	if (messageBudget < minimumRequiredBudget) {
		throw new Error(
			`Builder fixed context is approximately ${fixedTokens} tokens, leaving only ${messageBudget} ` +
				`for messages. Increase contextBudget.maxInputTokens or reduce the system/tool schema size.`,
		);
	}

	const requiredStart = turns.length - requiredTurnCount;
	const selectedNewestFirst: Message[][] = [];
	let usedTokens = 0;

	// Preserve the newest complete turns first. Reserve a small allowance for each
	// remaining required turn, while allowing the newest turn to receive most space.
	for (let index = turns.length - 1; index >= requiredStart; index--) {
		const remainingRequiredTurns = index - requiredStart;
		const reservedForOlderRequired = remainingRequiredTurns * MINIMUM_TURN_BUDGET_TOKENS;
		const available = Math.max(
			MINIMUM_TURN_BUDGET_TOKENS,
			messageBudget - usedTokens - reservedForOlderRequired,
		);
		const turn = turns[index];
		if (!turn) continue;
		const selectedTurn =
			estimateContextTokens(turn) <= available ? turn : compactTurnToBudget(turn, available);
		selectedNewestFirst.push(selectedTurn);
		usedTokens += estimateContextTokens(selectedTurn);
	}

	// Add older complete turns newest-first only while they fit in the remaining budget.
	for (let index = requiredStart - 1; index >= 0; index--) {
		const turn = turns[index];
		if (!turn) continue;
		const turnTokens = estimateContextTokens(turn);
		if (usedTokens + turnTokens > messageBudget) break;
		selectedNewestFirst.push(turn);
		usedTokens += turnTokens;
	}

	const selected = selectedNewestFirst.reverse().flat();
	if (estimateContextTokens(selected) <= messageBudget) return selected;

	// A message can contain non-text metadata or file parts that cannot be safely
	// rewritten block-by-block. Preserve the latest request/result as text rather
	// than exceeding the configured prompt ceiling or relying on provider truncation.
	return emergencyFallback(selected, messageBudget);
}
