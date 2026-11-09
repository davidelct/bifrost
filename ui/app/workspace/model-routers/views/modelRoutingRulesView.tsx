import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PIN_SHADOW_RIGHT } from "@/components/table/columnPinning";
import { getErrorMessage } from "@/lib/store";
import {
	useDeleteModelRoutingRuleMutation,
	useGetModelRoutersQuery,
	useGetModelRoutingRulesQuery,
	useUpdateModelRoutingRuleMutation,
} from "@/lib/store/apis/governanceApi";
import { COMPLEXITY_TIER_VALUES } from "@/lib/types/complexityRouter";
import { ModelRoutingRule, ModelRoutingRuleRequest } from "@/lib/types/routingRules";
import { getScopeLabel } from "@/lib/utils/labels";
import { getPriorityBadgeClass, truncateCELExpression } from "@/lib/utils/routingRules";
import { RbacOperation, RbacResource, useRbac } from "@enterprise/lib";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { DeleteRuleDialog, RuleActionsMenu } from "@/app/workspace/routing-rules/views/ruleShared";
import { ModelRoutingRuleSheet } from "./modelRoutingRuleSheet";

// The request a rule saves as, for edits made from the table.
function toRequest(rule: ModelRoutingRule, changes: Partial<ModelRoutingRuleRequest>): ModelRoutingRuleRequest {
	return {
		name: rule.name,
		description: rule.description,
		enabled: rule.enabled,
		cel_expression: rule.cel_expression,
		query: rule.query,
		model_router_id: rule.model_router_id,
		scope: rule.scope,
		scope_id: rule.scope_id ?? undefined,
		priority: rule.priority,
		targets: rule.targets,
		...changes,
	};
}

// TierTargets lists the model each tier gets, tier by tier.
export function TierTargets({ rule }: { rule: ModelRoutingRule }) {
	const { t } = useTranslation("models", { keyPrefix: "routing.modelRoutingRules" });
	return (
		<div className="flex flex-col gap-1">
			{COMPLEXITY_TIER_VALUES.map((tier) => {
				const models = rule.targets
					.filter((target) => target.tier === tier)
					.map((target) => [target.provider, target.model].filter(Boolean).join("/") || t("incomingModel"));
				if (models.length === 0) return null;
				return (
					<span key={tier} className="text-xs">
						<span className="text-muted-foreground">{t(`tiers.${tier}`)}</span> → <span className="font-mono">{models.join(", ")}</span>
					</span>
				);
			})}
		</div>
	);
}

// RouterRulesSummary names the model routing rules that send requests to a
// router, for the router's page.
export function RouterRulesSummary({ routerId, onOpenRules }: { routerId: string; onOpenRules: () => void }) {
	const { t } = useTranslation("models", { keyPrefix: "routing.modelRoutingRules" });
	const { data } = useGetModelRoutingRulesQuery();
	const rules = (data?.rules ?? []).filter((rule) => rule.model_router_id === routerId);
	return (
		<div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="model-router-rules-summary">
			<span>{rules.length === 0 ? t("usedByNone") : t("usedBy", { count: rules.length })}</span>
			{rules.map((rule) => (
				<Badge key={rule.id} variant="secondary" className="font-normal">
					{rule.name}
				</Badge>
			))}
			<Button
				type="button"
				variant="link"
				size="sm"
				className="h-auto p-0 text-xs"
				onClick={onOpenRules}
				data-testid="model-router-open-rules-link"
			>
				{t("manageRules")}
			</Button>
		</div>
	);
}

// ModelRoutingRulesView lists the model routing rules, the order they are
// tried in within a scope, and opens the sheet to create or edit one.
export function ModelRoutingRulesView() {
	const { t } = useTranslation("models");
	const { t: tmr } = useTranslation("models", { keyPrefix: "routing.modelRoutingRules" });
	const canCreate = useRbac(RbacResource.Governance, RbacOperation.Create);
	const canUpdate = useRbac(RbacResource.Governance, RbacOperation.Update);
	const canDelete = useRbac(RbacResource.Governance, RbacOperation.Delete);
	const { data, isLoading, error } = useGetModelRoutingRulesQuery();
	const { data: routersData } = useGetModelRoutersQuery();
	const [updateRule] = useUpdateModelRoutingRuleMutation();
	const [deleteRule, { isLoading: isDeleting }] = useDeleteModelRoutingRuleMutation();
	const [sheetOpen, setSheetOpen] = useState(false);
	const [editingRule, setEditingRule] = useState<ModelRoutingRule | null>(null);
	const [deleteId, setDeleteId] = useState<string | null>(null);

	const routerNames = useMemo(() => new Map((routersData?.routers ?? []).map((router) => [router.id, router.name])), [routersData]);
	const rules = useMemo(() => [...(data?.rules ?? [])].sort((a, b) => a.priority - b.priority), [data]);
	const ruleToDelete = rules.find((rule) => rule.id === deleteId);

	const openSheet = (rule: ModelRoutingRule | null) => {
		setEditingRule(rule);
		setSheetOpen(true);
	};

	const confirmDelete = () => {
		if (!deleteId) return;
		deleteRule(deleteId)
			.unwrap()
			.then(() => toast.success(tmr("deletedSuccess")))
			.catch((err) => toast.error(getErrorMessage(err)))
			.finally(() => setDeleteId(null));
	};

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<p className="text-muted-foreground max-w-3xl text-sm">{tmr("listDescription")}</p>
				<Button
					type="button"
					size="sm"
					disabled={!canCreate}
					onClick={() => openSheet(null)}
					data-testid="model-routing-rule-create-button"
				>
					<Plus className="size-4" />
					{tmr("newRule")}
				</Button>
			</div>

			<div className="overflow-hidden rounded-sm border">
				<Table containerClassName="h-full overflow-auto">
					<TableHeader className="bg-muted sticky top-0 z-10">
						<TableRow className="bg-muted/50">
							<TableHead className="font-semibold">{t("routing.name")}</TableHead>
							<TableHead className="font-semibold">{tmr("routerLabel")}</TableHead>
							<TableHead className="font-semibold">{tmr("targetsLabel")}</TableHead>
							<TableHead className="font-semibold">{t("routing.scope")}</TableHead>
							<TableHead className="text-right font-semibold">{t("routing.priority")}</TableHead>
							<TableHead className="font-semibold">{tmr("conditionLabel")}</TableHead>
							<TableHead className="font-semibold">{t("routing.status")}</TableHead>
							<TableHead className={`bg-muted sticky right-0 z-30 w-[50px] text-right font-semibold ${PIN_SHADOW_RIGHT}`}>
								{t("routing.actions")}
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{isLoading ? (
							<TableRow>
								<TableCell colSpan={8} className="h-10">
									<div className="bg-muted h-2 w-32 animate-pulse rounded" />
								</TableCell>
							</TableRow>
						) : error ? (
							<TableRow>
								<TableCell colSpan={8} className="text-destructive h-24 text-center text-sm">
									{tmr("loadFailed", { error: getErrorMessage(error) })}
								</TableCell>
							</TableRow>
						) : rules.length === 0 ? (
							<TableRow>
								<TableCell colSpan={8} className="h-24 text-center">
									<span className="text-muted-foreground text-sm">{tmr("empty")}</span>
								</TableCell>
							</TableRow>
						) : (
							rules.map((rule) => (
								<TableRow
									key={rule.id}
									className="hover:bg-muted/50 cursor-pointer transition-colors"
									onClick={() => canUpdate && openSheet(rule)}
									data-testid={`model-routing-rule-row-${rule.id}`}
								>
									<TableCell className="font-medium">
										<div className="flex flex-col gap-1">
											<span className="max-w-xs truncate">{rule.name}</span>
											{rule.description && <span className="text-muted-foreground max-w-xs truncate text-xs">{rule.description}</span>}
										</div>
									</TableCell>
									<TableCell>{routerNames.get(rule.model_router_id) ?? rule.model_router_id}</TableCell>
									<TableCell>
										<TierTargets rule={rule} />
									</TableCell>
									<TableCell>
										<Badge variant="secondary">{getScopeLabel(rule.scope)}</Badge>
									</TableCell>
									<TableCell className="text-right">
										<div className={`inline-block rounded px-2.5 py-1 text-xs font-medium ${getPriorityBadgeClass()}`}>{rule.priority}</div>
									</TableCell>
									<TableCell>
										<span className="text-muted-foreground block max-w-xs truncate font-mono text-xs" title={rule.cel_expression}>
											{rule.cel_expression ? truncateCELExpression(rule.cel_expression) : tmr("everyRequest")}
										</span>
									</TableCell>
									<TableCell onClick={(event) => event.stopPropagation()}>
										<Switch
											data-testid={`model-routing-rule-enabled-${rule.id}-switch`}
											checked={rule.enabled}
											size="md"
											disabled={!canUpdate}
											onAsyncCheckedChange={async (checked) => {
												try {
													await updateRule({ id: rule.id, data: toRequest(rule, { enabled: checked }) }).unwrap();
												} catch (err) {
													toast.error(getErrorMessage(err));
												}
											}}
										/>
									</TableCell>
									<TableCell
										className={`bg-card sticky right-0 text-right ${PIN_SHADOW_RIGHT}`}
										onClick={(event) => event.stopPropagation()}
									>
										<RuleActionsMenu
											id={rule.id}
											name={rule.name}
											testIdPrefix="model-routing-rule"
											canUpdate={canUpdate}
											canDelete={canDelete}
											onEdit={() => openSheet(rule)}
											onDelete={() => setDeleteId(rule.id)}
										/>
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>

			<ModelRoutingRuleSheet open={sheetOpen} onOpenChange={setSheetOpen} editingRule={editingRule} />

			<DeleteRuleDialog
				open={Boolean(deleteId)}
				onOpenChange={(open) => !open && setDeleteId(null)}
				title={tmr("deleteTitle")}
				description={tmr("deleteDescription", { name: ruleToDelete?.name ?? "" })}
				isDeleting={isDeleting}
				onConfirm={confirmDelete}
			/>
		</div>
	);
}