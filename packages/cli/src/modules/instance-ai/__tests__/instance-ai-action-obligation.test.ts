import { describe, expect, it } from 'vitest';

import {
	createWorkflowActionObligation,
	readActionObligationRetries,
} from '../instance-ai-action-obligation';

describe('createWorkflowActionObligation', () => {
	it.each([
		'Create a workflow with a Manual Trigger and Edit Fields node.',
		'Please rename the workflow and connect the two nodes.',
		'Can you build a workflow with a webhook trigger?',
		'I need you to fix the HTTP Request node in this workflow.',
	])('enforces strong workflow action request: %s', (message) => {
		const obligation = createWorkflowActionObligation(message, 3);
		expect(obligation).toMatchObject({ kind: 'action', maxRetries: 3 });
		expect(obligation?.satisfyingTools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolName: 'build-workflow',
					outputField: 'success',
					outputValues: [true],
				}),
			]),
		);
	});

	it('requires the matching workflows mutation for destructive actions', () => {
		const obligation = createWorkflowActionObligation('Archive this workflow.');
		expect(obligation?.satisfyingTools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolName: 'workflows',
					inputField: 'action',
					inputValues: ['delete'],
					outputField: 'success',
					outputValues: [true],
				}),
			]),
		);
		expect(
			obligation?.satisfyingTools.some((matcher) => matcher.toolName === 'build-workflow'),
		).toBe(false);
	});

	it('uses build-workflow when removing a node rather than archiving the workflow', () => {
		const obligation = createWorkflowActionObligation(
			'Remove the HTTP Request node from this workflow.',
		);
		expect(obligation?.satisfyingTools).toEqual(
			expect.arrayContaining([expect.objectContaining({ toolName: 'build-workflow' })]),
		);
		expect(
			obligation?.satisfyingTools.some(
				(matcher) =>
					matcher.toolName === 'workflows' &&
					matcher.inputField === 'action' &&
					matcher.inputValues?.includes('delete'),
			),
		).toBe(false);
	});

	it('accepts persisted planning for an explicit workflow plan request', () => {
		const obligation = createWorkflowActionObligation('Plan a workflow for this process.');
		expect(obligation?.satisfyingTools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolName: 'create-tasks',
					outputField: 'taskCount',
					outputNumberMinimum: 1,
				}),
			]),
		);
		expect(
			obligation?.satisfyingTools.some((matcher) => matcher.toolName === 'build-workflow'),
		).toBe(false);
	});

	it('allows either build-workflow or workflows setup for configuration requests', () => {
		const obligation = createWorkflowActionObligation('Configure this workflow.');
		expect(obligation?.satisfyingTools).toEqual(
			expect.arrayContaining([expect.objectContaining({ toolName: 'build-workflow' })]),
		);
		expect(obligation?.satisfyingTools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolName: 'workflows',
					inputField: 'action',
					inputValues: ['setup'],
				}),
			]),
		);
	});

	it('does not treat a lightweight checklist as completion of the requested action', () => {
		const obligation = createWorkflowActionObligation('Create a workflow with two nodes.');
		expect(
			obligation?.satisfyingTools.some(({ toolName }) =>
				['task-control', 'ask-user'].includes(toolName),
			),
		).toBe(false);
	});

	it.each([
		'How do I create a workflow with a webhook?',
		'Can you explain how to rename an Edit Fields node?',
		'Tell me what build-workflow does.',
		'What is a Manual Trigger?',
	])('allows explanation-only request: %s', (message) => {
		expect(createWorkflowActionObligation(message)).toBeUndefined();
	});

	it.each([
		'Create a marketing plan.',
		'Rename this document.',
		'Please explain this workflow.',
		'Can you help me?',
	])('does not activate outside strong workflow action scope: %s', (message) => {
		expect(createWorkflowActionObligation(message)).toBeUndefined();
	});
});

describe('readActionObligationRetries', () => {
	it.each([undefined, '', '0', '-1', '1.5', 'abc'])('falls back for %s', (value) => {
		expect(readActionObligationRetries(value, 2)).toBe(2);
	});

	it('accepts a positive integer', () => {
		expect(readActionObligationRetries('4', 2)).toBe(4);
	});
});
