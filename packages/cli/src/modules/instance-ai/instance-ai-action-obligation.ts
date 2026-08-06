import type { CompletionObligationOptions } from '@n8n/agents';

const EXPLANATION_ONLY = [
	/^\s*(?:what|why|how|when|where|who|which)\b/i,
	/^\s*(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:explain|describe|compare|tell|show\s+me\s+how|walk\s+me\s+through)\b/i,
	/^\s*(?:explain|describe|compare|tell\s+me|show\s+me\s+how|walk\s+me\s+through|help\s+me\s+understand)\b/i,
];

const ACTION_VERB_SOURCE =
	'create|build|make|add|insert|connect|rename|update|modify|change|edit|fix|repair|replace|remove|delete|archive|unarchive|publish|unpublish|activate|deactivate|configure|set\\s*up|implement|apply|generate|clone|duplicate|import|plan';
const ACTION_VERBS = `(?:${ACTION_VERB_SOURCE})`;

const ACTION_REQUEST = [
	new RegExp(`^\\s*(?:please\\s+)?${ACTION_VERBS}\\b`, 'i'),
	new RegExp(`^\\s*(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${ACTION_VERBS}\\b`, 'i'),
	new RegExp(`^\\s*i\\s+(?:want|need|would\\s+like)\\s+you\\s+to\\s+${ACTION_VERBS}\\b`, 'i'),
];

const WORKFLOW_CONTEXT =
	/\b(?:workflow|workflows|node|nodes|trigger|canvas|edit fields|manual trigger|webhook trigger|schedule trigger|http request|code node|set node)\b/i;
const NODE_CONTEXT =
	/\b(?:node|nodes|trigger|edit fields|manual trigger|webhook trigger|schedule trigger|http request|code node|set node)\b/i;
const EXPLICIT_WORKFLOW_DELETE =
	/\b(?:delete|remove)\s+(?:(?:this|the|that|my|a|an)\s+)?workflow\b/i;

const ACTION_VERB_CAPTURE = new RegExp(`\\b(${ACTION_VERB_SOURCE})\\b`, 'i');

const CREATE_TASKS_MATCHERS = [
	{ toolName: 'create-tasks', outputField: 'taskCount', outputNumberMinimum: 1 },
	{
		toolName: 'create-tasks',
		outputField: 'result',
		outputStringPrefixes: ['User denied the plan.', 'The user denied a plan earlier in this turn.'],
	},
] satisfies CompletionObligationOptions['satisfyingTools'];

function withSuccessfulOrDeniedOutcome(
	matcher: CompletionObligationOptions['satisfyingTools'][number],
): CompletionObligationOptions['satisfyingTools'] {
	return [
		{ ...matcher, outputField: 'success', outputValues: [true] },
		{ ...matcher, outputField: 'denied', outputValues: [true] },
	];
}

function getPrimaryActionVerb(message: string): string | undefined {
	return ACTION_VERB_CAPTURE.exec(message)?.[1]?.toLowerCase().replace(/\s+/g, '');
}

function getWorkflowActionTools(message: string): CompletionObligationOptions['satisfyingTools'] {
	const verb = getPrimaryActionVerb(message);
	switch (verb) {
		case 'archive':
			return withSuccessfulOrDeniedOutcome({
				toolName: 'workflows',
				inputField: 'action',
				inputValues: ['delete'],
			});
		case 'delete':
		case 'remove':
			return EXPLICIT_WORKFLOW_DELETE.test(message) && !NODE_CONTEXT.test(message)
				? withSuccessfulOrDeniedOutcome({
						toolName: 'workflows',
						inputField: 'action',
						inputValues: ['delete'],
					})
				: withSuccessfulOrDeniedOutcome({ toolName: 'build-workflow' });
		case 'unarchive':
			return withSuccessfulOrDeniedOutcome({
				toolName: 'workflows',
				inputField: 'action',
				inputValues: ['unarchive'],
			});
		case 'publish':
		case 'activate':
			return withSuccessfulOrDeniedOutcome({
				toolName: 'workflows',
				inputField: 'action',
				inputValues: ['publish'],
			});
		case 'unpublish':
		case 'deactivate':
			return withSuccessfulOrDeniedOutcome({
				toolName: 'workflows',
				inputField: 'action',
				inputValues: ['unpublish'],
			});
		case 'configure':
		case 'setup':
			return [
				...withSuccessfulOrDeniedOutcome({ toolName: 'build-workflow' }),
				...withSuccessfulOrDeniedOutcome({
					toolName: 'workflows',
					inputField: 'action',
					inputValues: ['setup'],
				}),
			];
		case 'plan':
			return [];
		default:
			return withSuccessfulOrDeniedOutcome({ toolName: 'build-workflow' });
	}
}

export function readActionObligationRetries(raw: string | undefined, fallback = 2): number {
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isExplanationOnly(message: string): boolean {
	return EXPLANATION_ONLY.some((pattern) => pattern.test(message));
}

function isStrongActionRequest(message: string): boolean {
	return ACTION_REQUEST.some((pattern) => pattern.test(message));
}

/**
 * Deterministic, intentionally narrow v1 classifier for workflow-building turns.
 * It avoids generic semantic guessing: only strong imperative/action phrasing plus
 * explicit workflow/node context activates the runtime obligation.
 */
export function createWorkflowActionObligation(
	message: string,
	maxRetries = 2,
): CompletionObligationOptions | undefined {
	if (!message.trim() || isExplanationOnly(message)) return undefined;
	if (!isStrongActionRequest(message) || !WORKFLOW_CONTEXT.test(message)) return undefined;

	return {
		kind: 'action',
		maxRetries,
		satisfyingTools: [...getWorkflowActionTools(message), ...CREATE_TASKS_MATCHERS],
		correctiveInstruction:
			'You have narrated or planned a workflow action without carrying it out. Continue the same request now. Brief narration is welcome, but do not finish until you have successfully called the qualifying workflow action tool or persisted a real implementation plan with create-tasks. When genuinely required information is missing, call ask-user; the action requirement will remain active after the user answers. Do not repeat the plan as the final answer.',
	};
}
