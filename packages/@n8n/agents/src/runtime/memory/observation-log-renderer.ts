import type {
	ObservationLogEntry,
	ObservationLogMarker,
	TokenCounter,
} from '../../types/sdk/observation-log';
import { estimateObservationTokens } from '../../types/sdk/observation-log';

const MARKER_LABELS: Record<ObservationLogMarker, string> = {
	critical: 'CRITICAL',
	important: 'IMPORTANT',
	info: 'INFO',
	completion: 'COMPLETION',
};

const MARKER_PRIORITY: Record<ObservationLogMarker, number> = {
	critical: 4,
	important: 3,
	completion: 2,
	info: 1,
};

const MEMORY_INTRO =
	'The following is your memory of this conversation. It accumulates as observations are made. Older entries may have been merged or dropped during periodic restructuring.';
const MARKER_LEGEND =
	'Marker legend: CRITICAL = must retain, IMPORTANT = useful continuity, INFO = contextual detail, COMPLETION = completed/resolved.';

export interface RenderObservationLogOptions {
	renderTokenBudget?: number;
	tokenCounter?: TokenCounter;
}

interface IndexedEntry {
	entry: ObservationLogEntry;
	inputIndex: number;
}

function compareChronologically(a: IndexedEntry, b: IndexedEntry): number {
	const timeDiff = a.entry.createdAt.getTime() - b.entry.createdAt.getTime();
	if (timeDiff !== 0) return timeDiff;
	return a.inputIndex - b.inputIndex;
}

function compareForSelection(a: IndexedEntry, b: IndexedEntry): number {
	const priorityDiff = MARKER_PRIORITY[b.entry.marker] - MARKER_PRIORITY[a.entry.marker];
	if (priorityDiff !== 0) return priorityDiff;

	const timeDiff = b.entry.createdAt.getTime() - a.entry.createdAt.getTime();
	if (timeDiff !== 0) return timeDiff;

	return b.inputIndex - a.inputIndex;
}

function formatObservationTime(date: Date): string {
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	return `${hours}:${minutes}`;
}

function observationTokenCount(entry: ObservationLogEntry, tokenCounter: TokenCounter): number {
	if (Number.isFinite(entry.tokenCount) && entry.tokenCount > 0) return entry.tokenCount;
	return tokenCounter(entry.text);
}

function renderBullet(entry: ObservationLogEntry, indent = ''): string {
	return `${indent}* ${MARKER_LABELS[entry.marker]} (${formatObservationTime(entry.createdAt)}) ${entry.text}`;
}

function isBuilderState(entry: ObservationLogEntry): boolean {
	return entry.text.trimStart().startsWith('BUILDER STATE:');
}

function keepNewestBuilderState(entries: IndexedEntry[]): IndexedEntry[] {
	let newestBuilderState: IndexedEntry | undefined;

	for (const indexedEntry of entries) {
		if (!isBuilderState(indexedEntry.entry)) continue;

		if (
			!newestBuilderState ||
			indexedEntry.entry.createdAt.getTime() > newestBuilderState.entry.createdAt.getTime() ||
			(indexedEntry.entry.createdAt.getTime() === newestBuilderState.entry.createdAt.getTime() &&
				indexedEntry.inputIndex > newestBuilderState.inputIndex)
		) {
			newestBuilderState = indexedEntry;
		}
	}

	return entries.filter(
		(indexedEntry) => !isBuilderState(indexedEntry.entry) || indexedEntry === newestBuilderState,
	);
}

export function renderObservationLog(
	entries: ObservationLogEntry[],
	options: RenderObservationLogOptions = {},
): string | null {
	const activeEntries = entries
		.map((entry, inputIndex) => ({ entry, inputIndex }))
		.filter(({ entry }) => entry.status === 'active');

	const eligibleEntries = keepNewestBuilderState(activeEntries);
	const tokenCounter = options.tokenCounter ?? estimateObservationTokens;
	let remainingTokens = options.renderTokenBudget ?? Number.POSITIVE_INFINITY;
	const includedIds = new Set<string>();

	for (const { entry } of [...eligibleEntries].sort(compareForSelection)) {
		const tokenCount = observationTokenCount(entry, tokenCounter);
		if (tokenCount > remainingTokens) continue;

		includedIds.add(entry.id);
		remainingTokens -= tokenCount;
	}

	if (includedIds.size === 0) return null;

	const selectedEntries = eligibleEntries
		.filter(({ entry }) => includedIds.has(entry.id))
		.sort(compareChronologically);

	const selectedById = new Map(
		selectedEntries.map((indexedEntry) => [indexedEntry.entry.id, indexedEntry]),
	);
	const childrenByParent = new Map<string, IndexedEntry[]>();
	const roots: IndexedEntry[] = [];

	for (const indexedEntry of selectedEntries) {
		const { entry } = indexedEntry;

		if (entry.parentId && selectedById.has(entry.parentId)) {
			const children = childrenByParent.get(entry.parentId) ?? [];
			children.push(indexedEntry);
			childrenByParent.set(entry.parentId, children);
		} else if (!entry.parentId) {
			roots.push(indexedEntry);
		}
	}

	if (roots.length === 0) return null;

	const lines: string[] = ['<observations>', MEMORY_INTRO, MARKER_LEGEND, ''];
	const renderedIds = new Set<string>();

	const appendEntry = (indexedEntry: IndexedEntry, depth: number): void => {
		if (renderedIds.has(indexedEntry.entry.id)) return;
		renderedIds.add(indexedEntry.entry.id);
		lines.push(renderBullet(indexedEntry.entry, '  '.repeat(depth)));

		for (const child of childrenByParent.get(indexedEntry.entry.id) ?? []) {
			appendEntry(child, depth + 1);
		}
	};

	for (const root of roots) {
		appendEntry(root, 0);
	}

	// Defensive fallback for malformed cyclic relationships: do not silently drop selected entries.
	for (const indexedEntry of selectedEntries) {
		if (!renderedIds.has(indexedEntry.entry.id)) appendEntry(indexedEntry, 0);
	}

	lines.push('</observations>');
	return lines.join('\n');
}