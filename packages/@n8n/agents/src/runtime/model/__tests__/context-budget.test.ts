import { describe, expect, it } from 'vitest';

import { budgetAgentMessages, estimateContextTokens } from '../context-budget';
import type { Message } from '../../../types/sdk/message';

function textMessage(role: Message['role'], text: string): Message {
	return { role, content: [{ type: 'text', text }] };
}

describe('budgetAgentMessages', () => {
	it('keeps newest complete turns before older history', () => {
		const messages: Message[] = [
			textMessage('user', `old request ${'a'.repeat(2_000)}`),
			textMessage('assistant', `old reply ${'b'.repeat(2_000)}`),
			textMessage('user', 'new request'),
			textMessage('assistant', 'new reply'),
		];

		const result = budgetAgentMessages({
			messages,
			system: { role: 'system', content: 'builder instructions' },
			options: { maxInputTokens: 400, minimumRecentTurns: 1, maxToolResultTokens: 64 },
		});

		expect(JSON.stringify(result)).toContain('new request');
		expect(JSON.stringify(result)).not.toContain('old request');
	});

	it('compacts settled tool payloads without mutating stored history', () => {
		const originalOutput = { workflow: 'x'.repeat(20_000) };
		const toolMessage: Message = {
			role: 'assistant',
			content: [
				{
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName: 'get_workflow',
					input: { workflowId: 'wf-1' },
					state: 'resolved',
					output: originalOutput,
				},
			],
		};

		const result = budgetAgentMessages({
			messages: [textMessage('user', 'Inspect this workflow'), toolMessage],
			system: { role: 'system', content: 'builder instructions' },
			options: { maxInputTokens: 1_000, minimumRecentTurns: 1, maxToolResultTokens: 100 },
		});
		const rendered = JSON.stringify(result);

		expect(rendered).toContain('n8n_context_compacted');
		expect(originalOutput.workflow).toHaveLength(20_000);
		expect(JSON.stringify(toolMessage)).not.toContain('n8n_context_compacted');
		expect(estimateContextTokens(result)).toBeLessThan(1_000);
	});

	it('fails clearly when fixed context leaves no room for the latest turn', () => {
		expect(() =>
			budgetAgentMessages({
				messages: [textMessage('user', 'current request')],
				system: { role: 'system', content: 's'.repeat(8_000) },
				options: { maxInputTokens: 1_024, minimumRecentTurns: 1 },
			}),
		).toThrow(/fixed context/i);
	});
});
