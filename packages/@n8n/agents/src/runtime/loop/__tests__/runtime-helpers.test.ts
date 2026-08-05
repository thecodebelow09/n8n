import type { TokenUsage } from '../../../types/sdk/agent';
import { mergeUsage } from '../runtime-helpers';

describe('mergeUsage — input token details', () => {
	it('sums noCache across both sides', () => {
		const a: TokenUsage = {
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			inputTokenDetails: { noCache: 10 },
		};
		const b: TokenUsage = {
			promptTokens: 20,
			completionTokens: 3,
			totalTokens: 23,
			inputTokenDetails: { noCache: 20 },
		};

		const merged = mergeUsage(a, b);

		expect(merged?.inputTokenDetails).toEqual({ noCache: 30 });
	});

	it('preserves noCache when only one side carries it', () => {
		const a: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
		const b: TokenUsage = {
			promptTokens: 20,
			completionTokens: 3,
			totalTokens: 23,
			inputTokenDetails: { noCache: 20 },
		};

		const merged = mergeUsage(a, b);

		expect(merged?.inputTokenDetails).toMatchObject({ noCache: 20 });
	});

	it('sums noCache alongside cacheRead and cacheWrite', () => {
		const a: TokenUsage = {
			promptTokens: 30,
			completionTokens: 5,
			totalTokens: 35,
			inputTokenDetails: { noCache: 10, cacheRead: 5, cacheWrite: 15 },
		};
		const b: TokenUsage = {
			promptTokens: 30,
			completionTokens: 5,
			totalTokens: 35,
			inputTokenDetails: { noCache: 20, cacheRead: 5, cacheWrite: 5 },
		};

		const merged = mergeUsage(a, b);

		expect(merged?.inputTokenDetails).toEqual({ noCache: 30, cacheRead: 10, cacheWrite: 20 });
	});
});

// ---------------------------------------------------------------------------
// isEmptyCompletion
// ---------------------------------------------------------------------------

import { isEmptyCompletion, normalizeFinishReason } from '../runtime-helpers';
import type { AgentMessage } from '../../../types/sdk/message';

function makeTurn(overrides: {
	aiFinishReason?: string;
	messages?: AgentMessage[];
	toolCalls?: readonly unknown[];
}): { aiFinishReason: string; newMessages: AgentMessage[]; toolCalls: readonly unknown[] } {
	return {
		aiFinishReason: overrides.aiFinishReason ?? 'stop',
		newMessages: overrides.messages ?? [],
		toolCalls: overrides.toolCalls ?? [],
	};
}

function assistantMsg(content: Array<{ type: 'text' | 'reasoning'; text: string }>): AgentMessage {
	return { role: 'assistant', content };
}

describe('isEmptyCompletion', () => {
	it('returns true when stop with empty messages and zero tool calls', () => {
		expect(isEmptyCompletion(makeTurn({ aiFinishReason: 'stop' }))).toBe(true);
	});

	it('returns true when length with empty messages and zero tool calls', () => {
		expect(isEmptyCompletion(makeTurn({ aiFinishReason: 'length' }))).toBe(true);
	});

	it('returns false when stop with text content', () => {
		const turn = makeTurn({
			aiFinishReason: 'stop',
			messages: [assistantMsg([{ type: 'text', text: 'done' }])],
		});
		expect(isEmptyCompletion(turn)).toBe(false);
	});

	it('returns false when stop with tool calls', () => {
		const turn = makeTurn({
			aiFinishReason: 'stop',
			toolCalls: [{ toolCallId: '1', toolName: 'foo' }],
		});
		expect(isEmptyCompletion(turn)).toBe(false);
	});

	it('returns false for tool-calls finish reason even with empty messages', () => {
		const turn = makeTurn({ aiFinishReason: 'tool-calls' });
		expect(isEmptyCompletion(turn)).toBe(false);
	});

	it('returns false for error finish reason', () => {
		const turn = makeTurn({ aiFinishReason: 'error' });
		expect(isEmptyCompletion(turn)).toBe(false);
	});

	it('returns false for content-filter finish reason (provider error)', () => {
		const turn = makeTurn({ aiFinishReason: 'content-filter' });
		expect(isEmptyCompletion(turn)).toBe(false);
	});

	it('returns false for other finish reason (provider error)', () => {
		const turn = makeTurn({ aiFinishReason: 'other' });
		expect(isEmptyCompletion(turn)).toBe(false);
	});

	it('returns false for unknown finish reason (provider error)', () => {
		const turn = makeTurn({ aiFinishReason: 'unknown' });
		expect(isEmptyCompletion(turn)).toBe(false);
	});

	it('treats reasoning content as NOT visible text', () => {
		const turn = makeTurn({
			aiFinishReason: 'stop',
			messages: [assistantMsg([{ type: 'reasoning', text: 'thinking silently' }])],
		});
		expect(isEmptyCompletion(turn)).toBe(true);
	});

	it('returns false when text coexists with tool calls', () => {
		const turn = makeTurn({
			aiFinishReason: 'tool-calls',
			messages: [assistantMsg([{ type: 'text', text: 'I will use the tool' }])],
			toolCalls: [{ toolCallId: '1', toolName: 'foo' }],
		});
		// tool-calls is not in EMPTY_COMPLETION_FINISH_REASONS
		expect(isEmptyCompletion(turn)).toBe(false);
	});

	it('returns true for length with reasoning-only content', () => {
		const turn = makeTurn({
			aiFinishReason: 'length',
			messages: [assistantMsg([{ type: 'reasoning', text: 'thinking' }])],
		});
		expect(isEmptyCompletion(turn)).toBe(true);
	});

	it('returns false when tool calls present even without visible text', () => {
		const turn = makeTurn({
			aiFinishReason: 'stop',
			toolCalls: [{ toolCallId: '1', toolName: 'foo' }],
		});
		expect(isEmptyCompletion(turn)).toBe(false);
	});
});

describe('normalizeFinishReason', () => {
	it('returns the reason when truthy', () => {
		expect(normalizeFinishReason('stop')).toBe('stop');
		expect(normalizeFinishReason('length')).toBe('length');
	});

	it('returns unknown when null or undefined', () => {
		expect(normalizeFinishReason(null as unknown as string)).toBe('unknown');
		expect(normalizeFinishReason(undefined as unknown as string)).toBe('unknown');
	});
});

// ---------------------------------------------------------------------------
// AgentMessageList.removeLastResponseBatch
// ---------------------------------------------------------------------------

import { AgentMessageList } from '../../model/message-list';

describe('AgentMessageList.removeLastResponseBatch', () => {
	it('removes exactly the requested number of most recent response messages', () => {
		const list = new AgentMessageList();
		list.addInput([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
		list.addResponse([
			{
				id: 'msg-1',
				role: 'assistant' as const,
				content: [{ type: 'reasoning', text: 'first hidden block' }],
				createdAt: new Date(1000),
			},
			{
				id: 'msg-2',
				role: 'assistant' as const,
				content: [{ type: 'reasoning', text: 'second hidden block' }],
				createdAt: new Date(1001),
			},
		]);

		const removed = list.removeLastResponseBatch(2);

		expect(removed.map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
		expect(list.messages()).toHaveLength(1);
		const [firstMessage] = list.messages();
		expect(firstMessage && 'role' in firstMessage ? firstMessage.role : undefined).toBe('user');
	});

	it('does not remove an earlier response when the empty turn added zero messages', () => {
		const list = new AgentMessageList();
		list.addInput([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
		list.addResponse([
			{
				id: 'valid-response',
				role: 'assistant' as const,
				content: [{ type: 'text', text: 'keep me' }],
				createdAt: new Date(1000),
			},
		]);

		const removed = list.removeLastResponseBatch(0);

		expect(removed).toHaveLength(0);
		expect(list.messages().some((message) => message.id === 'valid-response')).toBe(true);
	});

	it('is safe when fewer response messages exist than requested', () => {
		const list = new AgentMessageList();
		list.addInput([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);

		const removed = list.removeLastResponseBatch(2);

		expect(removed).toHaveLength(0);
		expect(list.messages()).toHaveLength(1);
	});
});
