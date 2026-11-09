import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PIN_SHADOW_RIGHT } from "@/components/table/columnPinning";
import { getErrorMessage, useGetProvidersQuery } from "@/lib/store";
import {
	useDeleteModelRouterMutation,
	useGetComplexitySuggestionsQuery,
	useGetModelRoutersQuery,
	useGetModelRouterStatusQuery,
	useGetModelRoutingRulesQuery,
} from "@/lib/store/apis/governanceApi";
import { useGetAllKeysQuery } from "@/lib/store/apis/providersApi";
import { DEFAULT_COMPLEXITY_ROUTER_ID, ModelRouter } from "@/lib/types/complexityRouter";
import { RbacOperation, RbacResource, useRbac } from "@enterprise/lib";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { DeleteRuleDialog, RuleActionsMenu } from "@/app/workspace/routing-rules/views/ruleShared";
import { DecisionProviderState, getDecisionProviderState, isRouterConfigured } from "../formSchema";
import { ClassifierStateChip } from "./classifierStatusBadge";
import RouterDetailsDialog from "./routerDetailsDialog";

// RouterClassifier names the classifier a router uses and the model behind it.
function RouterClassifier({ router }: { router: ModelRouter }) {
	const { t } = useTranslation("models", { keyPrefix: "routing.modelRouters" });
	if (router.classifier === "decision") {
		return (
			<div className="flex flex-col gap-0.5">
				<span>{t("classifierDecision")}</span>
				{router.decision?.model && <span className="text-muted-foreground text-xs">{router.decision.model}</span>}
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-0.5">
			<span>{t("classifierSemantic")}</span>
			{router.semantic?.embedding_model && <span className="text-muted-foreground text-xs">{router.semantic.embedding_model}</span>}
		</div>
	);
}

// RouterStatus is the router's classifier readiness, polled while it warms. A
// decision router has no warmup, so it shows its provider's state instead.
function RouterStatus({ router, decisionProvider }: { router: ModelRouter; decisionProvider?: DecisionProviderState }) {
	const configured = isRouterConfigured(router);
	const isDecision = router.classifier === "decision";
	const [pollingInterval, setPollingInterval] = useState(0);
	const { data: status } = useGetModelRouterStatusQuery(router.id, { skip: !configured || isDecision, pollingInterval });
	useEffect(() => setPollingInterval(status?.state === "warming" ? 2000 : 0), [status?.state]);
	const decision = isDecision && decisionProvider ? { provider: router.decision?.provider ?? "", state: decisionProvider } : undefined;
	return <ClassifierStateChip status={status} isNotConfigured={!configured} decision={decision} routerId={router.id} />;
}

// RouterSuggestions is the count of phrase suggestions waiting for review.
function RouterSuggestions({ router }: { router: ModelRouter }) {
	const { t } = useTranslation("models", { keyPrefix: "routing.modelRouters" });
	const enabled = Boolean(router.suggestions?.enabled);
	const { data } = useGetComplexitySuggestionsQuery({ statuses: ["open"], routerId: router.id }, { skip: !enabled });
	if (!enabled) return <span className="text-muted-foreground">{t("suggestionsOff")}</span>;
	return <span>{t("suggestionsPending", { count: data?.counts.open ?? 0 })}</span>;
}

interface ModelRoutersViewProps {
	// chooseClassifier opens a router just started fresh on its classifier
	// choice; a copy of the Default router is ready to use and opens on setup.
	onOpenRouter: (id: string, chooseClassifier?: boolean) => void;
}

// ModelRoutersView lists the model routers. Each one classifies the requests
// model routing rules send it; the Default router also answers the routing
// rules' complexity_tier.
export function ModelRoutersView({ onOpenRouter }: ModelRoutersViewProps) {
	const { t } = useTranslation("models", { keyPrefix: "routing.modelRouters" });
	const { t: tm } = useTranslation("models");
	const canCreate = useRbac(RbacResource.Governance, RbacOperation.Create);
	const canUpdate = useRbac(RbacResource.Governance, RbacOperation.Update);
	const canDelete = useRbac(RbacResource.Governance, RbacOperation.Delete);
	const { data, isLoading, error } = useGetModelRoutersQuery();
	const { data: rulesData } = useGetModelRoutingRulesQuery();
	const [deleteRouter, { isLoading: isDeleting }] = useDeleteModelRouterMutation();
	const [createOpen, setCreateOpen] = useState(false);
	// Kept after the dialog closes, so it stays an edit while it animates out.
	const [editingRouter, setEditingRouter] = useState<ModelRouter | null>(null);
	const [editOpen, setEditOpen] = useState(false);
	const [deleteId, setDeleteId] = useState<string | null>(null);

	const ruleCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const rule of rulesData?.rules ?? []) counts.set(rule.model_router_id, (counts.get(rule.model_router_id) ?? 0) + 1);
		return counts;
	}, [rulesData]);
	const routers = data?.routers ?? [];
	const routerToDelete = routers.find((router) => router.id === deleteId);

	// Decision routers are judged by their provider, as the router page's alert does.
	const hasDecisionRouter = routers.some((router) => router.classifier === "decision");
	const { data: providers, isLoading: providersLoading } = useGetProvidersQuery(undefined, { skip: !hasDecisionRouter });
	const { data: keys, isLoading: keysLoading } = useGetAllKeysQuery(undefined, { skip: !hasDecisionRouter });
	const decisionProviderState = (router: ModelRouter) =>
		providersLoading || keysLoading ? undefined : getDecisionProviderState(providers, keys, router.decision?.provider ?? "");

	// A router that model routing rules still name cannot be deleted; the
	// gateway's refusal names them, so it is shown as it comes.
	const confirmDelete = () => {
		if (!deleteId) return;
		deleteRouter(deleteId)
			.unwrap()
			.then(() => toast.success(t("deleted"), { position: "top-right" }))
			.catch((err) => toast.error(getErrorMessage(err)))
			.finally(() => setDeleteId(null));
	};

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<p className="text-muted-foreground max-w-3xl text-sm">{t("listDescription")}</p>
				<Button type="button" size="sm" disabled={!canCreate} onClick={() => setCreateOpen(true)} data-testid="model-router-create-button">
					<Plus className="size-4" />
					{t("newRouter")}
				</Button>
			</div>

			<div className="overflow-hidden rounded-sm border">
				<Table containerClassName="h-full overflow-auto">
					<TableHeader className="bg-muted sticky top-0 z-10">
						<TableRow className="bg-muted/50">
							<TableHead className="font-semibold">{t("columnName")}</TableHead>
							<TableHead className="font-semibold">{t("columnClassifier")}</TableHead>
							<TableHead className="font-semibold">{t("columnStatus")}</TableHead>
							<TableHead className="font-semibold">{t("columnSuggestions")}</TableHead>
							<TableHead className="font-semibold">{t("columnRules")}</TableHead>
							<TableHead className={`bg-muted sticky right-0 z-30 w-[50px] text-right font-semibold ${PIN_SHADOW_RIGHT}`}>
								{tm("routing.actions")}
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{isLoading ? (
							<TableRow>
								<TableCell colSpan={6} className="h-10">
									<div className="bg-muted h-2 w-32 animate-pulse rounded" />
								</TableCell>
							</TableRow>
						) : error ? (
							<TableRow>
								<TableCell colSpan={6} className="text-destructive h-24 text-center text-sm">
									{t("loadFailed", { error: getErrorMessage(error) })}
								</TableCell>
							</TableRow>
						) : (
							routers.map((router) => {
								const ruleCount = ruleCounts.get(router.id) ?? 0;
								return (
									<TableRow
										key={router.id}
										className="hover:bg-muted/50 cursor-pointer transition-colors"
										onClick={() => onOpenRouter(router.id)}
										data-testid={`model-router-row-${router.id}`}
									>
										<TableCell className="font-medium">
											<div className="flex flex-col gap-1">
												<span className="flex items-center gap-2">
													<span className="max-w-xs truncate">{router.name}</span>
													{router.id === DEFAULT_COMPLEXITY_ROUTER_ID && <Badge variant="secondary">{t("defaultBadge")}</Badge>}
												</span>
												<span className="text-muted-foreground max-w-md truncate text-xs">
													{router.description || (router.id === DEFAULT_COMPLEXITY_ROUTER_ID ? t("defaultDescription") : "")}
												</span>
											</div>
										</TableCell>
										<TableCell>
											<RouterClassifier router={router} />
										</TableCell>
										<TableCell>
											<RouterStatus router={router} decisionProvider={decisionProviderState(router)} />
										</TableCell>
										<TableCell>
											<RouterSuggestions router={router} />
										</TableCell>
										<TableCell>
											{ruleCount === 0 ? (
												<span className="text-muted-foreground">{t("rulesNone")}</span>
											) : (
												t("rulesCount", { count: ruleCount })
											)}
										</TableCell>
										<TableCell
											className={`bg-card sticky right-0 text-right ${PIN_SHADOW_RIGHT}`}
											onClick={(event) => event.stopPropagation()}
										>
											<RuleActionsMenu
												id={router.id}
												name={router.name}
												testIdPrefix="model-router"
												ariaLabel={t("actionsAria", { name: router.name })}
												canUpdate={canUpdate}
												canDelete={canDelete && router.id !== DEFAULT_COMPLEXITY_ROUTER_ID}
												onEdit={() => {
													setEditingRouter(router);
													setEditOpen(true);
												}}
												onDelete={() => setDeleteId(router.id)}
											/>
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</div>

			<RouterDetailsDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				onCreated={(id, startFrom) => onOpenRouter(id, startFrom === "builtin")}
			/>

			<RouterDetailsDialog open={editOpen} onOpenChange={setEditOpen} router={editingRouter ?? undefined} />

			<DeleteRuleDialog
				open={Boolean(deleteId)}
				onOpenChange={(open) => !open && setDeleteId(null)}
				title={t("deleteTitle", { name: routerToDelete?.name ?? "" })}
				description={t("deleteDescription")}
				isDeleting={isDeleting}
				onConfirm={confirmDelete}
			/>
		</div>
	);
}