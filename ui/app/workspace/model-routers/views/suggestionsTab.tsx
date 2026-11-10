import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdownMenu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getLocale } from "@/lib/i18n";
import { getErrorMessage } from "@/lib/store";
import { useAppDispatch } from "@/lib/store/hooks";
import {
	governanceApi,
	useGetComplexitySuggestionQuery,
	useGetComplexitySuggestionsQuery,
	useUpdateComplexitySuggestionStatusMutation,
} from "@/lib/store/apis/governanceApi";
import {
	COMPLEXITY_TIER_VALUES,
	DEFAULT_COMPLEXITY_ROUTER_ID,
	DecisionTier,
	SUGGESTION_CATEGORIES,
	Suggestion,
	SuggestionCategory,
	SuggestionRun,
} from "@/lib/types/complexityRouter";
import { cn } from "@/lib/utils";
import {
	CalendarDays,
	ChevronDown,
	ChevronsUpDown,
	FlaskConical,
	GripVertical,
	LoaderCircle,
	Pencil,
	Play,
	Plus,
	Search,
	Settings2,
	Sparkles,
	TriangleAlert,
	Undo2,
} from "lucide-react";
import { DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import PhraseTestDialog from "./phraseTestDialog";
import RunNowDialog from "./runNowDialog";
import { categoryCounts, filterSuggestions, StagedSuggestion } from "./suggestions.utils";

interface Props {
	// The router these suggestions belong to.
	routerId?: string;
	canUpdate: boolean;
	// Whether the saved config has suggestions on; the form may differ until
	// it is saved.
	enabled: boolean;
	lookbackDays: number;
	staged: StagedSuggestion[];
	// Phrases each tier's draft list holds now, staged ones included.
	tierCounts: Record<DecisionTier, number>;
	// The similarity floor a nearest phrase must clear; 0 or absent means none.
	minSimilarity?: number;
	// Phrases the bank can still take before the cap.
	remainingPhrases: number;
	onStage: (suggestion: Suggestion, tier: DecisionTier, phrases: string[]) => number;
	onUnstage: (id: string) => void;
	onEditStaged: (id: string, from: string, to: string) => void;
	onOpenSettings: () => void;
	// Why requests are not captured for suggestions, when they are not.
	captureUnavailableReason?: "no_vector_store" | "embedded_vector_store";
}

type ListTab = "open" | "dismissed";

const TOAST_POSITION = { position: "top-right" } as const;

// How long the list waits for a run it started to record itself and finish.
const AWAIT_RUN_LIMIT_MS = 10 * 60 * 1000;

// SuggestionsTab lists the phrases suggested from routed traffic next to the
// three tiers. Dragging rows onto a tier, or adding them from a row or a
// selection, stages their phrases into the draft phrase lists, where they can
// be edited or sent back; the page's Save applies them and marks the
// suggestions accepted.
export default function SuggestionsTab({
	routerId = DEFAULT_COMPLEXITY_ROUTER_ID,
	canUpdate,
	enabled,
	lookbackDays,
	staged,
	tierCounts,
	minSimilarity,
	remainingPhrases,
	onStage,
	onUnstage,
	onEditStaged,
	onOpenSettings,
	captureUnavailableReason,
}: Props) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const { t: tTier } = useTranslation("models", { keyPrefix: "routing.complexityUi" });
	const [listTab, setListTab] = useState<ListTab>("open");
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<SuggestionCategory | "all">("all");
	const [testing, setTesting] = useState<Suggestion | null>(null);
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [dragIds, setDragIds] = useState<string[] | null>(null);

	// Polled only while a run is going, so its outcome replaces the spinner. A
	// run started here is queued before it records itself, so the list is also
	// polled until that run shows up as the latest one and has finished.
	const [awaitedRun, setAwaitedRun] = useState<string | null>(null);
	const [pollInterval, setPollInterval] = useState(0);
	const { data, isLoading, error, refetch } = useGetComplexitySuggestionsQuery(
		{ statuses: [listTab], routerId },
		{ pollingInterval: pollInterval },
	);
	const dispatch = useAppDispatch();
	const latestRun = data?.last_run;
	const awaiting = awaitedRun !== null && (latestRun?.id !== awaitedRun || latestRun.status === "running");
	const running = latestRun?.status === "running" || awaiting;
	useEffect(() => setPollInterval(running ? 3000 : 0), [running]);
	useEffect(() => {
		if (awaitedRun === null || awaiting) return;
		// Finished: refresh every view of the suggestions, the tab's count too.
		setAwaitedRun(null);
		dispatch(governanceApi.util.invalidateTags(["ComplexitySuggestions"]));
	}, [awaitedRun, awaiting, dispatch]);
	useEffect(() => {
		if (awaitedRun === null) return;
		// A run that never records itself (the node restarted, say) must not
		// keep the list polling forever.
		const timer = setTimeout(() => setAwaitedRun(null), AWAIT_RUN_LIMIT_MS);
		return () => clearTimeout(timer);
	}, [awaitedRun]);
	const [runDialogOpen, setRunDialogOpen] = useState(false);
	const [updateStatus] = useUpdateComplexitySuggestionStatusMutation();

	// A toast's Undo runs after later renders, so it must reach the parent's
	// current staging rather than the one captured when the toast was shown.
	const unstageRef = useRef(onUnstage);
	unstageRef.current = onUnstage;

	const stagedIds = useMemo(() => new Set(staged.map((entry) => entry.id)), [staged]);
	const suggestions = data?.suggestions ?? [];
	const counts = useMemo(() => categoryCounts(suggestions, stagedIds), [suggestions, stagedIds]);
	const visible = useMemo(() => filterSuggestions(suggestions, { query, category }, stagedIds), [suggestions, query, category, stagedIds]);
	const openCount = Math.max(0, (data?.counts.open ?? 0) - (listTab === "open" ? staged.length : 0));

	const pending = listTab === "open";
	const selectable = canUpdate && pending ? visible : [];
	const selectedRows = selectable.filter((suggestion) => selected.has(suggestion.id));
	const allExpanded = visible.length > 0 && visible.every((suggestion) => expanded.has(suggestion.id));

	const switchList = (tab: ListTab) => {
		setListTab(tab);
		setSelected(new Set());
	};

	const tierLabel = (tier: string) => {
		switch (tier) {
			case "SIMPLE":
				return tTier("tierSimple");
			case "MEDIUM":
				return tTier("tierMedium");
			case "COMPLEX":
				return tTier("tierComplex");
			default:
				return tier;
		}
	};

	// stage adds suggestions to a tier and offers to take the whole batch back.
	const stage = (rows: Suggestion[], tier: DecisionTier, phrases?: string[]) => {
		const added: string[] = [];
		for (const suggestion of rows) {
			if (onStage(suggestion, tier, phrases ?? suggestion.phrases) > 0) added.push(suggestion.id);
		}
		setSelected(new Set());
		setDragIds(null);
		if (added.length === 0) {
			toast.info(remainingPhrases === 0 ? t("atCap") : t("alreadyInBank"), TOAST_POSITION);
			return;
		}
		toast.success(t("addedToTier", { count: added.length, tier: tierLabel(tier) }), {
			...TOAST_POSITION,
			action: { label: t("undo"), onClick: () => added.forEach((id) => unstageRef.current(id)) },
		});
	};

	const setStatus = (rows: Suggestion[], status: "dismissed" | "open") => {
		const update = (row: Suggestion, next: "dismissed" | "open") =>
			updateStatus({ id: row.id, status: next, routerId: row.router_id }).unwrap();
		Promise.all(rows.map((row) => update(row, status)))
			.then(() => {
				setSelected(new Set());
				if (status === "open") {
					toast.success(t("restored"), TOAST_POSITION);
					return;
				}
				toast.success(rows.length === 1 ? t("dismissed") : t("dismissedMany", { count: rows.length }), {
					...TOAST_POSITION,
					action: { label: t("undo"), onClick: () => rows.forEach((row) => void update(row, "open")) },
				});
			})
			.catch((err) => toast.error(t("statusFailed", { error: getErrorMessage(err) }), TOAST_POSITION));
	};

	const toggleSelected = (id: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const toggleExpanded = (id: string) =>
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	// A drag carries the whole selection when it starts on a selected row.
	const startDrag = (event: DragEvent<HTMLDivElement>, suggestion: Suggestion) => {
		const rows = selected.has(suggestion.id) ? selectedRows : [suggestion];
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", rows.map((row) => row.id).join(","));
		const ghost = document.createElement("div");
		ghost.textContent = rows.length > 1 ? t("dragCount", { count: rows.length }) : suggestion.phrases.join(" · ");
		ghost.className =
			"bg-card text-foreground fixed -top-[200px] max-w-72 truncate rounded-sm border px-3 py-2 text-sm font-medium shadow-md";
		document.body.appendChild(ghost);
		event.dataTransfer.setDragImage(ghost, 16, 18);
		setTimeout(() => ghost.remove(), 0);
		// Deferred so the browser takes its drag image before the rows dim.
		setTimeout(() => setDragIds(rows.map((row) => row.id)), 0);
	};
	const dropOn = (tier: DecisionTier) => {
		if (!dragIds) return;
		const ids = new Set(dragIds);
		stage(
			visible.filter((suggestion) => ids.has(suggestion.id)),
			tier,
		);
	};

	// 503 means this deployment cannot keep suggestions (no log store); that is
	// a fact to state, not an error to retry.
	const unavailable = typeof error === "object" && error !== null && "status" in error && error.status === 503;

	return (
		<div className="space-y-4" data-testid="complexity-suggestions-tab">
			{!enabled && !(data?.enabled ?? false) && (
				<Alert variant="info" data-testid="complexity-suggestions-off-callout">
					<Sparkles className="h-4 w-4" />
					<AlertDescription className="flex flex-wrap items-center justify-between gap-2">
						<span>{t("offCallout")}</span>
						{canUpdate && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={onOpenSettings}
								data-testid="complexity-suggestions-turn-on-button"
							>
								{t("turnOn")}
							</Button>
						)}
					</AlertDescription>
				</Alert>
			)}

			{captureUnavailableReason && (
				<Alert variant="warning" data-testid="complexity-suggestions-capture-unavailable">
					<TriangleAlert className="h-4 w-4" />
					<AlertDescription>
						{captureUnavailableReason === "embedded_vector_store" ? t("captureUnavailableEmbedded") : t("captureUnavailableNone")}
					</AlertDescription>
				</Alert>
			)}

			{data?.last_run?.status === "failed" && data.last_run.error && (
				<Alert variant="warning" data-testid="complexity-suggestions-last-run-error">
					<AlertDescription>{t("lastRunFailed", { error: data.last_run.error })}</AlertDescription>
				</Alert>
			)}

			<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
				<section className="min-w-0 space-y-3">
					<div className="space-y-1">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="min-w-0">
								<h2 className="text-sm font-semibold">{t("title")}</h2>
							</div>
							<div className="flex shrink-0 flex-wrap items-center gap-2">
								<RunStatus run={data?.last_run} nextRunAt={data?.next_run_at} enabled={data?.enabled ?? enabled} />
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={onOpenSettings}
									aria-label={t("settings")}
									title={t("settings")}
									data-testid="complexity-suggestions-settings-button"
								>
									<Settings2 className="size-3.5" />
								</Button>
								{canUpdate && (data?.enabled ?? enabled) && !captureUnavailableReason && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => setRunDialogOpen(true)}
										disabled={running}
										data-testid="complexity-suggestions-run-now-button"
									>
										{running ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
										{running ? t("running") : t("runNow")}
									</Button>
								)}
							</div>
						</div>
						<p className="text-muted-foreground text-xs leading-relaxed">{t("description")}</p>
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<div className="bg-muted flex h-8 items-center rounded-sm p-0.5" role="tablist" aria-label={t("listAria")}>
							{(["open", "dismissed"] as const).map((tab) => (
								<button
									key={tab}
									type="button"
									role="tab"
									aria-selected={listTab === tab}
									onClick={() => switchList(tab)}
									data-testid={`complexity-suggestions-list-${tab}`}
									className={cn(
										"flex h-full items-center rounded-sm px-2.5 text-xs",
										listTab === tab ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
									)}
								>
									{tab === "open" ? t("pendingTab") : t("dismissedTab")}
									<span className="text-muted-foreground ml-1.5 font-mono text-[11px] tabular-nums">
										{tab === "open" ? openCount : (data?.counts.dismissed ?? 0)}
									</span>
								</button>
							))}
						</div>
						<div className="relative min-w-28 flex-1">
							<Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
							<input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={t("searchPlaceholder")}
								aria-label={t("searchPlaceholder")}
								className="border-input placeholder:text-muted-foreground focus-visible:ring-ring/50 h-8 w-full rounded-sm border bg-transparent pr-2 pl-8 text-xs outline-none focus-visible:ring-[3px]"
								data-testid="complexity-suggestions-search-input"
							/>
						</div>
						<Select value={category} onValueChange={(value) => setCategory(value as SuggestionCategory | "all")}>
							<SelectTrigger
								className="h-8 w-auto gap-1.5 text-xs"
								data-testid="complexity-suggestions-category-select"
								aria-label={t("reasonAria")}
							>
								<span className="text-muted-foreground">{t("reasonLabel")}</span>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">{t("allReasons", { n: counts.all })}</SelectItem>
								{SUGGESTION_CATEGORIES.map((value) => (
									<SelectItem key={value} value={value} data-testid={`complexity-suggestions-category-option-${value}`}>
										{t(`categoryOption.${value}`, { n: counts[value] })}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<span className="text-muted-foreground inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-xs">
							<CalendarDays className="size-3.5" />
							{t("lastDays", { count: lookbackDays })}
						</span>
					</div>

					<div className="rounded-sm border" data-testid="complexity-suggestions-list-card">
						{visible.length > 0 && (
							<ListHeader
								total={selectable.length || visible.length}
								selectedCount={selectedRows.length}
								selectable={selectable.length > 0}
								allExpanded={allExpanded}
								canExpand={visible.length > 0}
								tierLabel={tierLabel}
								onToggleAll={() =>
									setSelected(
										selectedRows.length === selectable.length ? new Set() : new Set(selectable.map((suggestion) => suggestion.id)),
									)
								}
								onAddSelected={(tier) => stage(selectedRows, tier)}
								onDismissSelected={() => setStatus(selectedRows, "dismissed")}
								onToggleExpandAll={() => setExpanded(allExpanded ? new Set() : new Set(visible.map((suggestion) => suggestion.id)))}
							/>
						)}

						{isLoading ? (
							<div className="text-muted-foreground flex items-center gap-2 px-3 py-8 text-sm">
								<LoaderCircle className="size-4 animate-spin" />
								{t("loading")}
							</div>
						) : unavailable ? (
							<p className="text-muted-foreground px-3 py-8 text-sm" data-testid="complexity-suggestions-unavailable">
								{getErrorMessage(error)}
							</p>
						) : error ? (
							<div className="space-y-2 px-3 py-8">
								<p className="text-muted-foreground text-sm">{t("loadFailed", { error: getErrorMessage(error) })}</p>
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => refetch()}
									data-testid="complexity-suggestions-retry-button"
								>
									{t("retry")}
								</Button>
							</div>
						) : visible.length === 0 ? (
							<p className="text-muted-foreground px-3 py-10 text-center text-sm" data-testid="complexity-suggestions-empty">
								{suggestions.length - stagedIds.size > 0 && (query || category !== "all")
									? t("noMatches")
									: pending
										? t("emptyPending")
										: t("emptyDismissed")}
							</p>
						) : (
							<div className="divide-y" data-testid="complexity-suggestions-list">
								{visible.map((suggestion) => (
									<SuggestionRow
										key={suggestion.id}
										suggestion={suggestion}
										dismissed={!pending}
										canUpdate={canUpdate}
										selectable={selectable.length > 0}
										selected={selected.has(suggestion.id)}
										expanded={expanded.has(suggestion.id)}
										dragging={dragIds?.includes(suggestion.id) ?? false}
										minSimilarity={minSimilarity}
										tierLabel={tierLabel}
										onToggleSelected={() => toggleSelected(suggestion.id)}
										onToggleExpanded={() => toggleExpanded(suggestion.id)}
										onDragStart={(event) => startDrag(event, suggestion)}
										onDragEnd={() => setDragIds(null)}
										onAdd={(tier) => stage([suggestion], tier)}
										onTest={() => setTesting(suggestion)}
										onDismiss={() => setStatus([suggestion], "dismissed")}
										onRestore={() => setStatus([suggestion], "open")}
									/>
								))}
							</div>
						)}
					</div>
				</section>

				<TierPanel
					staged={staged}
					tierCounts={tierCounts}
					dragCount={dragIds?.length ?? 0}
					canUpdate={canUpdate}
					tierLabel={tierLabel}
					onDrop={dropOn}
					onUnstage={(id) => {
						onUnstage(id);
						toast.info(t("sentBack"), TOAST_POSITION);
					}}
					onEdit={onEditStaged}
				/>
			</div>

			<RunNowDialog
				open={runDialogOpen}
				onOpenChange={setRunDialogOpen}
				routerId={routerId}
				lookbackDays={lookbackDays}
				onStarted={setAwaitedRun}
			/>

			<PhraseTestDialog
				suggestion={testing}
				onOpenChange={(open) => !open && setTesting(null)}
				canStage={canUpdate && pending}
				onStage={(suggestion, tier, phrases) => stage([suggestion], tier, phrases)}
			/>
		</div>
	);
}

function RunStatus({ run, nextRunAt, enabled }: { run?: SuggestionRun; nextRunAt?: string; enabled: boolean }) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const format = (value: string) => new Date(value).toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" });
	return (
		<div className="text-muted-foreground space-y-0.5 text-right text-[11px] leading-tight">
			{run && (
				<p data-testid="complexity-suggestions-last-run">
					{run.status === "running"
						? t("lastRunRunning", { time: format(run.started_at) })
						: run.status === "failed"
							? t("lastRunFailedShort", { time: format(run.finished_at ?? run.started_at) })
							: t("lastRunSummary", { time: format(run.finished_at ?? run.started_at), count: run.created })}
				</p>
			)}
			{enabled && nextRunAt && <p data-testid="complexity-suggestions-next-run">{t("nextRun", { time: format(nextRunAt) })}</p>}
		</div>
	);
}

interface ListHeaderProps {
	total: number;
	selectedCount: number;
	selectable: boolean;
	allExpanded: boolean;
	canExpand: boolean;
	tierLabel: (tier: string) => string;
	onToggleAll: () => void;
	onAddSelected: (tier: DecisionTier) => void;
	onDismissSelected: () => void;
	onToggleExpandAll: () => void;
}

// ListHeader counts the list, or the selection and what can be done with it.
function ListHeader({
	total,
	selectedCount,
	selectable,
	allExpanded,
	canExpand,
	tierLabel,
	onToggleAll,
	onAddSelected,
	onDismissSelected,
	onToggleExpandAll,
}: ListHeaderProps) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const hasSelection = selectedCount > 0;
	return (
		<div
			className="bg-muted/30 flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5"
			data-testid="complexity-suggestions-list-header"
		>
			{selectable && (
				<Checkbox
					checked={!hasSelection ? false : selectedCount === total ? true : "indeterminate"}
					onCheckedChange={onToggleAll}
					aria-label={t("selectAllAria")}
					data-testid="complexity-suggestions-select-all"
				/>
			)}
			<span className={cn("text-xs", hasSelection ? "font-medium" : "text-muted-foreground")}>
				{hasSelection ? t("selectedCount", { selected: selectedCount, total }) : t("listHeader", { count: total })}
			</span>
			{hasSelection && (
				<>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" size="sm" className="h-7" data-testid="complexity-suggestions-bulk-add">
								<Plus className="size-3.5" />
								{t("addSelected")}
								<ChevronDown className="size-3" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							{COMPLEXITY_TIER_VALUES.map((tier) => (
								<DropdownMenuItem
									key={tier}
									onSelect={() => onAddSelected(tier)}
									data-testid={`complexity-suggestions-bulk-add-${tier.toLowerCase()}`}
								>
									{tierLabel(tier)}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-7"
						onClick={onDismissSelected}
						data-testid="complexity-suggestions-bulk-dismiss"
					>
						{t("dismissSelected", { n: selectedCount })}
					</Button>
					<span className="text-muted-foreground hidden text-xs xl:inline">{t("dragHint")}</span>
				</>
			)}
			{canExpand && (
				<button
					type="button"
					onClick={onToggleExpandAll}
					className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
					data-testid="complexity-suggestions-expand-all"
				>
					<ChevronsUpDown className="size-3.5" />
					{allExpanded ? t("collapseAll") : t("expandAll")}
				</button>
			)}
		</div>
	);
}

interface RowProps {
	suggestion: Suggestion;
	dismissed: boolean;
	canUpdate: boolean;
	selectable: boolean;
	selected: boolean;
	expanded: boolean;
	dragging: boolean;
	minSimilarity?: number;
	tierLabel: (tier: string) => string;
	onToggleSelected: () => void;
	onToggleExpanded: () => void;
	onDragStart: (event: DragEvent<HTMLDivElement>) => void;
	onDragEnd: () => void;
	onAdd: (tier: DecisionTier) => void;
	onTest: () => void;
	onDismiss: () => void;
	onRestore: () => void;
}

function SuggestionRow({
	suggestion,
	dismissed,
	canUpdate,
	selectable,
	selected,
	expanded,
	dragging,
	minSimilarity,
	tierLabel,
	onToggleSelected,
	onToggleExpanded,
	onDragStart,
	onDragEnd,
	onAdd,
	onTest,
	onDismiss,
	onRestore,
}: RowProps) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const id = suggestion.id;
	const draggable = canUpdate && !dismissed;
	const number = (value: number) => new Intl.NumberFormat(getLocale()).format(value);

	return (
		<div
			draggable={draggable}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			className={cn(
				"group transition-opacity",
				expanded ? "bg-muted/30" : selected && "bg-muted/50",
				dragging && "opacity-40",
				draggable && "cursor-grab active:cursor-grabbing",
			)}
			data-testid={`complexity-suggestion-row-${id}`}
		>
			<div className="flex items-center gap-2 px-3 py-2.5">
				{selectable && (
					<Checkbox
						checked={selected}
						onCheckedChange={onToggleSelected}
						aria-label={t("selectRowAria")}
						data-testid={`complexity-suggestion-select-${id}`}
					/>
				)}
				{draggable && (
					<GripVertical
						className={cn(
							"size-3.5 shrink-0",
							selected ? "text-muted-foreground" : "text-muted-foreground/40 group-hover:text-muted-foreground",
						)}
						aria-hidden
					/>
				)}
				<button
					type="button"
					onClick={onToggleExpanded}
					aria-expanded={expanded}
					aria-label={t("expandAria")}
					className="min-w-0 flex-1 cursor-[inherit] space-y-0.5 text-left"
					data-testid={`complexity-suggestion-expand-${id}`}
				>
					<span className="flex min-w-0 items-center gap-2">
						<span className={cn("min-w-0 text-sm font-medium", expanded ? "break-words" : "truncate")}>
							{suggestion.phrases.map((phrase, index) => (
								<span key={phrase}>
									{index > 0 && <span className="text-muted-foreground px-1.5">/</span>}“{phrase}”
								</span>
							))}
						</span>
						{suggestion.phrases.length > 1 && (
							<Badge
								variant="secondary"
								className="h-4 shrink-0 px-1.5 text-[10px]"
								data-testid={`complexity-suggestion-phrase-count-${id}`}
							>
								{t("tierPhraseCount", { count: suggestion.phrases.length })}
							</Badge>
						)}
					</span>
					<span className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
						{t("reasonLine", {
							reason: t(`category.${suggestion.category}`),
							count: suggestion.request_count,
							formatted: number(suggestion.request_count),
						})}
						{suggestion.stale && (
							<Badge
								variant="warning"
								className="h-4 px-1.5 text-[10px]"
								title={t("staleTip")}
								data-testid={`complexity-suggestion-stale-${id}`}
							>
								{t("stale")}
							</Badge>
						)}
					</span>
				</button>
				{dismissed && canUpdate && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-7"
						onClick={onRestore}
						data-testid={`complexity-suggestion-restore-${id}`}
					>
						<Undo2 className="size-3.5" />
						{t("restore")}
					</Button>
				)}
				<button
					type="button"
					onClick={onToggleExpanded}
					tabIndex={-1}
					aria-hidden
					className="text-muted-foreground hover:text-foreground shrink-0 p-1"
				>
					<ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
				</button>
			</div>

			{expanded && (
				<div
					className="grid gap-x-6 gap-y-4 pr-3 pb-4 pl-3 text-xs sm:grid-cols-[7rem_minmax(0,1fr)] sm:pl-[3.25rem]"
					data-testid={`complexity-suggestion-details-${id}`}
				>
					<span className="text-muted-foreground">{t("whyHeading")}</span>
					<div className="space-y-2">
						<p className="leading-relaxed">{t(`categoryDescription.${suggestion.category}`)}</p>
						{suggestion.reason && <p className="text-muted-foreground leading-relaxed italic">{suggestion.reason}</p>}
						{suggestion.nearest_phrase && (
							<>
								<SimilarityBar similarity={suggestion.nearest_similarity} cutoff={minSimilarity} />
								<p className="text-muted-foreground">
									{t("nearestShort", { phrase: suggestion.nearest_phrase, tier: tierLabel(suggestion.nearest_tier ?? "") })}
								</p>
							</>
						)}
						<p className="text-muted-foreground">
							{t("coverageLine", {
								percent: new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 0 }).format(suggestion.coverage),
							})}
						</p>
					</div>

					<span className="text-muted-foreground">{t("howOftenHeading")}</span>
					<SuggestionExamples id={id} routerId={suggestion.router_id} count={suggestion.request_count} />

					{canUpdate && !dismissed && (
						<>
							<span className="hidden sm:block" />
							<div className="flex flex-wrap items-center gap-2">
								<div className="flex">
									<Button
										type="button"
										size="sm"
										className="h-7 rounded-r-none"
										onClick={() => onAdd(suggestion.tier)}
										data-testid={`complexity-suggestion-add-${id}`}
									>
										<Plus className="size-3.5" />
										{t("addToTier", { tier: tierLabel(suggestion.tier) })}
									</Button>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												type="button"
												size="sm"
												className="h-7 rounded-l-none border-l border-l-black/20 px-1.5"
												aria-label={t("otherTiersAria")}
												data-testid={`complexity-suggestion-add-menu-${id}`}
											>
												<ChevronDown className="size-3.5" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="start">
											{COMPLEXITY_TIER_VALUES.map((tier) => (
												<DropdownMenuItem
													key={tier}
													onSelect={() => onAdd(tier)}
													data-testid={`complexity-suggestion-add-${id}-${tier.toLowerCase()}`}
												>
													{t("addToTier", { tier: tierLabel(tier) })}
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-7"
									onClick={onTest}
									data-testid={`complexity-suggestion-test-${id}`}
								>
									<FlaskConical className="size-3.5" />
									{t("test")}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="ml-auto h-7"
									onClick={onDismiss}
									data-testid={`complexity-suggestion-dismiss-${id}`}
								>
									{t("dismiss")}
								</Button>
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}

// SimilarityBar draws how close the nearest phrase is, against the floor a
// match must clear when one is set.
function SimilarityBar({ similarity, cutoff }: { similarity: number; cutoff?: number }) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const fraction = (value: number) =>
		new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value);
	const clamp = (value: number) => `${Math.min(100, Math.max(0, value * 100))}%`;
	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const label = !hasCutoff
		? t("similarityOnly", { similarity: fraction(similarity) })
		: similarity >= cutoff
			? t("similarityAbove", { similarity: fraction(similarity), cutoff: fraction(cutoff) })
			: t("similarityBelow", { similarity: fraction(similarity), cutoff: fraction(cutoff) });
	return (
		<div className="flex flex-wrap items-center gap-3">
			<div className="bg-muted relative h-1.5 w-44 rounded-full" aria-hidden>
				<div className="bg-muted-foreground absolute inset-y-0 left-0 rounded-full" style={{ width: clamp(similarity) }} />
				{hasCutoff && <div className="bg-foreground absolute -top-1 -bottom-1 w-0.5 rounded-full" style={{ left: clamp(cutoff) }} />}
			</div>
			<span className="font-mono text-[11px] tabular-nums">{label}</span>
		</div>
	);
}

// SuggestionExamples reads the requests a suggestion came from, only once its
// row is opened.
function SuggestionExamples({ id, routerId, count }: { id: string; routerId: string; count: number }) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const { data, isLoading } = useGetComplexitySuggestionQuery({ id, routerId });
	const readable = (data?.examples ?? []).filter((example) => example.text);
	const hidden = (data?.examples.length ?? 0) - readable.length;
	return (
		<div className="min-w-0 space-y-1.5" data-testid={`complexity-suggestion-examples-${id}`}>
			<p className="leading-relaxed">{t("howOftenLine", { count, formatted: new Intl.NumberFormat(getLocale()).format(count) })}</p>
			{isLoading ? (
				<LoaderCircle className="text-muted-foreground size-3.5 animate-spin" />
			) : (
				<ul className="text-muted-foreground space-y-1">
					{readable.slice(0, 5).map((example) => (
						<li key={example.log_id} className="line-clamp-2 break-words">
							“{example.text}”
						</li>
					))}
				</ul>
			)}
			{hidden > 0 && <p className="text-muted-foreground italic">{t("hiddenExamples", { count: hidden })}</p>}
		</div>
	);
}

interface TierPanelProps {
	staged: StagedSuggestion[];
	tierCounts: Record<DecisionTier, number>;
	// Rows being dragged; 0 when nothing is.
	dragCount: number;
	canUpdate: boolean;
	tierLabel: (tier: string) => string;
	onDrop: (tier: DecisionTier) => void;
	onUnstage: (id: string) => void;
	onEdit: (id: string, from: string, to: string) => void;
}

// TierPanel holds a drop target per tier, showing what Save will add to it;
// the new phrases stay editable until then.
function TierPanel({ staged, tierCounts, dragCount, canUpdate, tierLabel, onDrop, onUnstage, onEdit }: TierPanelProps) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const [over, setOver] = useState<DecisionTier | null>(null);
	const dragging = dragCount > 0;
	useEffect(() => {
		if (!dragging) setOver(null);
	}, [dragging]);

	return (
		<aside className="h-fit space-y-3 lg:sticky lg:top-0" data-testid="complexity-suggestions-staged-panel">
			<div className="space-y-1">
				<p className="text-sm font-semibold">{t("tiersTitle")}</p>
				<p className="text-muted-foreground text-xs leading-relaxed">{t("tiersDescription")}</p>
			</div>
			{COMPLEXITY_TIER_VALUES.map((tier) => {
				const entries = staged.filter((entry) => entry.tier === tier);
				const added = entries.reduce((sum, entry) => sum + entry.phrases.length, 0);
				const isOver = over === tier;
				return (
					<div
						key={tier}
						onDragOver={(event) => {
							if (!dragging) return;
							event.preventDefault();
							event.dataTransfer.dropEffect = "move";
							if (over !== tier) setOver(tier);
						}}
						onDragLeave={(event) => {
							if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
						}}
						onDrop={(event) => {
							event.preventDefault();
							setOver(null);
							onDrop(tier);
						}}
						className={cn(
							"space-y-2 rounded-sm border p-3 transition-colors",
							isOver ? "border-foreground/60 bg-muted/60 border-dashed" : dragging && "border-dashed",
						)}
						data-testid={`complexity-suggestions-staged-${tier.toLowerCase()}`}
					>
						<div className="flex items-center gap-2">
							<span className="text-sm font-medium">{tierLabel(tier)}</span>
							<span className="text-muted-foreground ml-auto font-mono text-[11px] tabular-nums">
								{t("tierPhraseCount", { count: tierCounts[tier] })}
							</span>
							{added > 0 && <Badge variant="success">{t("newCount", { n: added })}</Badge>}
						</div>
						{dragging ? (
							<div
								className={cn(
									"rounded-sm border border-dashed px-3 py-3 text-center text-xs",
									isOver ? "border-foreground/60 text-foreground" : "text-muted-foreground",
								)}
							>
								{isOver ? t("releaseToAdd", { count: dragCount, tier: tierLabel(tier) }) : t("dropToAdd", { tier: tierLabel(tier) })}
							</div>
						) : entries.length === 0 ? (
							<p className="text-muted-foreground text-xs">{t("stagedEmpty")}</p>
						) : (
							<div className="space-y-1.5">
								{entries.flatMap((entry) =>
									entry.phrases.map((phrase, index) => (
										<StagedPhrase
											key={`${entry.id}-${phrase}`}
											id={entry.id}
											index={index}
											phrase={phrase}
											canUpdate={canUpdate}
											onCommit={(next) => onEdit(entry.id, phrase, next)}
											onUndo={() => onUnstage(entry.id)}
										/>
									)),
								)}
							</div>
						)}
					</div>
				);
			})}
			<p className="text-muted-foreground text-[11px] leading-relaxed">{t("tiersFooter")}</p>
		</aside>
	);
}

// StagedPhrase is one new phrase in a tier: its text, or a box to edit it that
// commits on Enter or blur and puts the text back on Esc.
function StagedPhrase({
	id,
	index,
	phrase,
	canUpdate,
	onCommit,
	onUndo,
}: {
	id: string;
	index: number;
	phrase: string;
	canUpdate: boolean;
	onCommit: (next: string) => void;
	onUndo: () => void;
}) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(phrase);
	const commit = () => {
		const next = draft.trim();
		setEditing(false);
		if (!next) {
			setDraft(phrase);
			return;
		}
		if (next !== phrase) onCommit(next);
	};

	return (
		<div
			className="bg-muted/40 group/chip flex items-start gap-2 rounded-sm border border-amber-500/30 px-2 py-1.5"
			data-testid={`complexity-suggestions-staged-phrase-${id}-${index}`}
		>
			<span className="mt-0.5 shrink-0 rounded-[3px] bg-amber-500/15 px-1 font-mono text-[9px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-300">
				{t("newTag")}
			</span>
			{editing ? (
				<div className="min-w-0 flex-1 space-y-1">
					<Textarea
						autoFocus
						value={draft}
						rows={Math.max(2, Math.ceil(draft.length / 34))}
						aria-label={t("stagedInputAria")}
						className="min-h-0 resize-none px-1.5 py-1 text-xs"
						data-testid={`complexity-suggestions-staged-input-${id}-${index}`}
						onChange={(event) => setDraft(event.target.value)}
						onBlur={commit}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								commit();
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setDraft(phrase);
								setEditing(false);
							}
						}}
					/>
					<p className="text-muted-foreground text-[10px]">{t("editHint")}</p>
				</div>
			) : (
				<span className="min-w-0 flex-1 text-xs leading-relaxed break-words">{phrase}</span>
			)}
			{canUpdate && !editing && (
				<div className="flex shrink-0 items-center">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="size-6 p-0"
						onClick={() => {
							setDraft(phrase);
							setEditing(true);
						}}
						aria-label={t("editPhrase")}
						data-testid={`complexity-suggestions-staged-edit-${id}-${index}`}
					>
						<Pencil className="size-3" />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="size-6 p-0"
						onClick={onUndo}
						aria-label={t("unstage")}
						data-testid={index === 0 ? `complexity-suggestions-staged-undo-${id}` : `complexity-suggestions-staged-undo-${id}-${index}`}
					>
						<Undo2 className="size-3" />
					</Button>
				</div>
			)}
		</div>
	);
}