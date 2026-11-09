import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/store";
import {
	useGetComplexitySuggestionsQuery,
	useGetModelRoutersQuery,
	useGetModelRouterStatusQuery,
	useGetModelRoutingRulesQuery,
} from "@/lib/store/apis/governanceApi";
import { DEFAULT_COMPLEXITY_ROUTER_ID, ModelRouter } from "@/lib/types/complexityRouter";
import { RbacOperation, RbacResource, useRbac } from "@enterprise/lib";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { isRouterConfigured } from "../formSchema";
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

// RouterStatus is the router's classifier readiness, polled while it warms.
function RouterStatus({ router }: { router: ModelRouter }) {
	const configured = isRouterConfigured(router);
	const [pollingInterval, setPollingInterval] = useState(0);
	const { data: status } = useGetModelRouterStatusQuery(router.id, { skip: !configured, pollingInterval });
	useEffect(() => setPollingInterval(status?.state === "warming" ? 2000 : 0), [status?.state]);
	return <ClassifierStateChip status={status} isNotConfigured={!configured} routerId={router.id} />;
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
	const canCreate = useRbac(RbacResource.Governance, RbacOperation.Create);
	const { data, isLoading, error } = useGetModelRoutersQuery();
	const { data: rulesData } = useGetModelRoutingRulesQuery();
	const [createOpen, setCreateOpen] = useState(false);

	const ruleCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const rule of rulesData?.rules ?? []) counts.set(rule.model_router_id, (counts.get(rule.model_router_id) ?? 0) + 1);
		return counts;
	}, [rulesData]);
	const routers = data?.routers ?? [];

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
				<Table>
					<TableHeader className="bg-muted">
						<TableRow className="bg-muted/50">
							<TableHead className="font-semibold">{t("columnName")}</TableHead>
							<TableHead className="font-semibold">{t("columnClassifier")}</TableHead>
							<TableHead className="font-semibold">{t("columnStatus")}</TableHead>
							<TableHead className="font-semibold">{t("columnSuggestions")}</TableHead>
							<TableHead className="font-semibold">{t("columnRules")}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{isLoading ? (
							<TableRow>
								<TableCell colSpan={5} className="h-10">
									<div className="bg-muted h-2 w-32 animate-pulse rounded" />
								</TableCell>
							</TableRow>
						) : error ? (
							<TableRow>
								<TableCell colSpan={5} className="text-destructive h-24 text-center text-sm">
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
											<RouterStatus router={router} />
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
		</div>
	);
}