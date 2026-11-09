import {
	CELRuleBuilder,
	type ConditionMode,
	FallbackRow,
	initialConditionMode,
	RuleScopeEntityField,
	RuleScopeSelect,
	scopeNoun,
	TargetRow,
} from "@/app/workspace/routing-rules/views/ruleShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type ProviderSelectorOption } from "@/components/ui/providerSelector";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { resolveProviderIconKey } from "@/lib/constants/icons";
import { getProviderLabel } from "@/lib/constants/logs";
import { getErrorMessage } from "@/lib/store";
import {
	useCreateModelRoutingRuleMutation,
	useGetModelRoutersQuery,
	useUpdateModelRoutingRuleMutation,
} from "@/lib/store/apis/governanceApi";
import { useGetAllKeysQuery, useGetProvidersQuery } from "@/lib/store/apis/providersApi";
import { COMPLEXITY_TIER_VALUES, DecisionTier, DEFAULT_COMPLEXITY_ROUTER_ID } from "@/lib/types/complexityRouter";
import {
	DEFAULT_ROUTING_FALLBACK,
	DEFAULT_ROUTING_TARGET,
	ModelRoutingRule,
	ModelRoutingRuleRequest,
	RoutingFallbackFormData,
	RoutingRuleScope,
	RoutingTargetFormData,
} from "@/lib/types/routingRules";
import { validateRateLimitAndBudgetRules, validateRoutingRules } from "@/lib/utils/celConverterRouting";
import { normalizeRoutingRuleGroupQuery } from "@/lib/utils/routingRuleGroupQuery";
import { denormalizeFallback, MAX_TTFT_TIMEOUT_MS, normalizeFallback, parseTTFTTimeoutInput } from "@/lib/utils/routingRules";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { RuleGroupType } from "react-querybuilder";
import { toast } from "sonner";

// A target in the form: one model for one tier, with the fallbacks and the
// first-token timeout that go with it.
interface TierTargetFormData extends RoutingTargetFormData {
	tier: DecisionTier;
	fallbacks: RoutingFallbackFormData[];
	// Raw input; empty means no timeout.
	ttft: string;
}

interface RuleFormData {
	name: string;
	description: string;
	enabled: boolean;
	model_router_id: string;
	scope: string;
	scope_id: string;
	priority: number;
	cel_expression: string;
}

const defaultQuery: RuleGroupType = { combinator: "and", rules: [] };

// The tier is what the rule's router decides once the rule has matched, so a
// rule's condition cannot use it.
const EXCLUDED_CEL_FIELDS = ["complexity_tier"];

const emptyForm = (routerId: string): RuleFormData => ({
	name: "",
	description: "",
	enabled: true,
	model_router_id: routerId,
	scope: RoutingRuleScope.Global,
	scope_id: "",
	priority: 0,
	cel_expression: "",
});

function toTierTargets(rule?: ModelRoutingRule | null): TierTargetFormData[] {
	return (rule?.targets ?? []).map((target) => ({
		tier: target.tier,
		provider: target.provider ?? "",
		model: target.model ?? "",
		key_id: target.key_id ?? "",
		weight: target.weight,
		fallbacks: (target.fallbacks ?? []).map(normalizeFallback),
		ttft: target.ttft_timeout_ms ? String(target.ttft_timeout_ms) : "",
	}));
}

// Checks the targets the way the gateway does, so the errors show next to the
// tier they are about instead of after a round trip.
function validateTargets(
	targets: TierTargetFormData[],
	t: TFunction<"models">,
): { form?: string; tiers: Partial<Record<DecisionTier, string>> } {
	const tiers: Partial<Record<DecisionTier, string>> = {};
	if (targets.length === 0) return { form: t("routing.modelRoutingRules.atLeastOneTarget"), tiers };
	for (const tier of COMPLEXITY_TIER_VALUES) {
		const inTier = targets.filter((target) => target.tier === tier);
		if (inTier.length === 0) continue;
		if (inTier.some((target) => !target.provider.trim() && !target.model.trim())) {
			tiers[tier] = t("routing.modelRoutingRules.providerOrModel");
		} else if (inTier.some((target) => !(target.weight > 0))) {
			tiers[tier] = t("routing.modelRoutingRules.weightPositive");
		} else if (inTier.some((target) => parseTTFTTimeoutInput(target.ttft) === null)) {
			tiers[tier] = t("routing.modelRoutingRules.ttftInvalid", { max: MAX_TTFT_TIMEOUT_MS });
		} else {
			const total = inTier.reduce((sum, target) => sum + target.weight, 0);
			if (Math.abs(total - 1) > 0.001) tiers[tier] = t("routing.modelRoutingRules.weightsMustSum", { total: total.toFixed(4) });
		}
	}
	return { tiers };
}

interface ModelRoutingRuleSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	editingRule?: ModelRoutingRule | null;
	// The router a new rule starts on, such as the one whose page opened it.
	defaultRouterId?: string;
}

// ModelRoutingRuleSheet creates or edits a model routing rule. It follows the
// routing rule sheet: the same name, scope, priority and condition fields,
// with the targets grouped by the tier the rule's router decides.
export function ModelRoutingRuleSheet({ open, onOpenChange, editingRule, defaultRouterId }: ModelRoutingRuleSheetProps) {
	const { t } = useTranslation("models");
	const { t: tc } = useTranslation("common");
	const { t: tmr } = useTranslation("models", { keyPrefix: "routing.modelRoutingRules" });
	const isEditing = Boolean(editingRule);
	const { data: routersData } = useGetModelRoutersQuery(undefined, { skip: !open });
	const { data: providersData = [] } = useGetProvidersQuery(undefined, { skip: !open });
	const { data: allKeysData = [] } = useGetAllKeysQuery(undefined, { skip: !open });
	const [createRule, { isLoading: isCreating }] = useCreateModelRoutingRuleMutation();
	const [updateRule, { isLoading: isUpdating }] = useUpdateModelRoutingRuleMutation();

	const [targets, setTargets] = useState<TierTargetFormData[]>([]);
	const [query, setQuery] = useState<RuleGroupType>(defaultQuery);
	const [conditionMode, setConditionMode] = useState<ConditionMode>("builder");
	const [builderKey, setBuilderKey] = useState(0);
	const [celError, setCelError] = useState<string | null>(null);
	const [targetErrors, setTargetErrors] = useState<{ form?: string; tiers: Partial<Record<DecisionTier, string>> }>({ tiers: {} });
	const [scopeError, setScopeError] = useState<string | null>(null);

	const {
		register,
		handleSubmit,
		reset,
		setValue,
		watch,
		formState: { errors },
	} = useForm<RuleFormData>({ defaultValues: emptyForm(defaultRouterId ?? DEFAULT_COMPLEXITY_ROUTER_ID) });
	const scope = watch("scope");
	const scopeId = watch("scope_id");
	const enabled = watch("enabled");
	const routerId = watch("model_router_id");

	useEffect(() => {
		if (!open) return;
		reset(
			editingRule
				? {
						name: editingRule.name,
						description: editingRule.description ?? "",
						enabled: editingRule.enabled,
						model_router_id: editingRule.model_router_id,
						scope: editingRule.scope,
						scope_id: editingRule.scope_id ?? "",
						priority: editingRule.priority,
						cel_expression: editingRule.cel_expression ?? "",
					}
				: emptyForm(defaultRouterId ?? DEFAULT_COMPLEXITY_ROUTER_ID),
		);
		setTargets(toTierTargets(editingRule));
		setQuery(editingRule ? normalizeRoutingRuleGroupQuery(editingRule.query) : defaultQuery);
		setConditionMode(initialConditionMode(editingRule));
		setBuilderKey((key) => key + 1);
		setCelError(null);
		setTargetErrors({ tiers: {} });
		setScopeError(null);
	}, [open, editingRule, defaultRouterId, reset]);

	// Providers the rule names but the gateway no longer has stay offerable, so
	// opening an old rule never blanks its targets.
	const configuredNames = useMemo(() => new Set<string>(providersData.map((provider) => provider.name)), [providersData]);
	const referencedProviderOptions = useMemo<ProviderSelectorOption[]>(() => {
		const referenced = new Set<string>();
		for (const target of targets) {
			if (target.provider) referenced.add(target.provider);
			for (const fallback of target.fallbacks) if (fallback.provider) referenced.add(fallback.provider);
		}
		return Array.from(referenced)
			.filter((name) => !configuredNames.has(name))
			.map((name) => ({ value: name, label: getProviderLabel(name), iconKey: resolveProviderIconKey(name) }));
	}, [targets, configuredNames]);
	const availableProviders = useMemo(
		() => Array.from(new Set<string>([...configuredNames, ...referencedProviderOptions.map((option) => option.value)])),
		[configuredNames, referencedProviderOptions],
	);

	const handleQueryChange = useCallback(
		(expression: string, newQuery: RuleGroupType) => {
			setValue("cel_expression", expression);
			setQuery(newQuery);
			setCelError(null);
		},
		[setValue],
	);
	const handleModeChange = useCallback((mode: ConditionMode) => {
		setConditionMode(mode);
		setCelError(null);
	}, []);

	// Targets are addressed by their place in the whole list; each tier renders
	// its own slice of it.
	const updateTarget = (index: number, changes: Partial<TierTargetFormData>) =>
		setTargets((current) => current.map((target, i) => (i === index ? { ...target, ...changes } : target)));
	const addTarget = (tier: DecisionTier) =>
		setTargets((current) => {
			const remaining = 1 - current.filter((target) => target.tier === tier).reduce((sum, target) => sum + (target.weight || 0), 0);
			return [
				...current,
				{ ...DEFAULT_ROUTING_TARGET, tier, weight: Math.max(0, parseFloat(remaining.toFixed(4))), fallbacks: [], ttft: "" },
			];
		});
	const removeTarget = (index: number) => setTargets((current) => current.filter((_, i) => i !== index));

	const onSubmit = (data: RuleFormData) => {
		setCelError(null);
		const checked = validateTargets(targets, t);
		setTargetErrors(checked);
		const missingScope = data.scope !== RoutingRuleScope.Global && !data.scope_id.trim();
		setScopeError(missingScope ? t("routing.scopeRequired", { scope: scopeNoun(data.scope, t) }) : null);
		if (checked.form || Object.keys(checked.tiers).length > 0 || missingScope) return;

		// Builder-only checks: they read the visual query, which raw-CEL mode does
		// not have. A CEL expression is checked by the gateway on save instead.
		if (conditionMode === "builder") {
			const builderErrors = [...validateRoutingRules(query), ...validateRateLimitAndBudgetRules(query)];
			if (builderErrors.length > 0) {
				setCelError(builderErrors.join("\n"));
				return;
			}
		}

		const payload: ModelRoutingRuleRequest = {
			name: data.name,
			description: data.description,
			enabled: data.enabled,
			cel_expression: data.cel_expression,
			query: conditionMode === "builder" ? query : undefined,
			model_router_id: data.model_router_id,
			scope: data.scope,
			scope_id: data.scope === RoutingRuleScope.Global ? undefined : data.scope_id || undefined,
			priority: data.priority,
			targets: targets.map((target) => ({
				tier: target.tier,
				provider: target.provider || undefined,
				model: target.model || undefined,
				key_id: target.key_id || undefined,
				weight: target.weight,
				ttft_timeout_ms: parseTTFTTimeoutInput(target.ttft) ?? undefined,
				fallbacks: target.fallbacks.filter((fallback) => fallback.provider.trim()).map(denormalizeFallback),
			})),
		};
		const saving = editingRule ? updateRule({ id: editingRule.id, data: payload }).unwrap() : createRule(payload).unwrap();
		saving
			.then(() => {
				toast.success(isEditing ? tmr("updatedSuccess") : tmr("createdSuccess"));
				onOpenChange(false);
			})
			.catch((error) => {
				const message = getErrorMessage(error);
				// A malformed condition is a field-level problem: show it under the
				// editor, as the routing rule sheet does.
				if (/cel|condition|complexity_tier/i.test(message)) {
					setCelError(message);
					return;
				}
				toast.error(message);
			});
	};

	const routers = routersData?.routers ?? [];

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex w-full min-w-1/2 flex-col gap-4 overflow-x-hidden p-0 pt-4" data-testid="model-routing-rule-sheet">
				<SheetHeader className="flex flex-col items-start py-4" headerClassName="mb-0 sticky -top-4 bg-card z-10 px-4 md:px-8">
					<SheetTitle>{isEditing ? tmr("editTitle") : tmr("createTitle")}</SheetTitle>
					<SheetDescription>{isEditing ? tmr("editDescription") : tmr("createDescription")}</SheetDescription>
				</SheetHeader>

				<form onSubmit={handleSubmit(onSubmit)} className="flex grow flex-col" noValidate>
					<div className="flex grow flex-col gap-6 px-4 pb-6 md:px-8">
						<div className="space-y-3">
							<Label htmlFor="model-routing-rule-name">
								{t("routing.ruleName")} <span className="text-red-500">*</span>
							</Label>
							<Input
								id="model-routing-rule-name"
								placeholder={t("routing.ruleNamePlaceholder")}
								data-testid="model-routing-rule-name-input"
								{...register("name", { required: t("routing.ruleNameRequired") })}
							/>
							{errors.name && <p className="text-destructive text-sm">{errors.name.message}</p>}
						</div>

						<div className="space-y-3">
							<Label htmlFor="model-routing-rule-description">{t("virtualKeys.description")}</Label>
							<Textarea
								id="model-routing-rule-description"
								rows={2}
								placeholder={t("routing.descriptionPlaceholder")}
								data-testid="model-routing-rule-description-input"
								{...register("description")}
							/>
						</div>

						<div className="flex items-center justify-between rounded-lg border p-4">
							<div className="space-y-0.5">
								<Label htmlFor="model-routing-rule-enabled">{t("routing.enableRule")}</Label>
								<p className="text-muted-foreground text-sm">{t("routing.enableRuleHelp")}</p>
							</div>
							<Switch
								id="model-routing-rule-enabled"
								checked={enabled}
								onCheckedChange={(checked) => setValue("enabled", checked)}
								data-testid="model-routing-rule-enabled-switch"
							/>
						</div>

						<div className="space-y-3">
							<Label htmlFor="model-routing-rule-router">
								{tmr("routerLabel")} <span className="text-red-500">*</span>
							</Label>
							<Select value={routerId} onValueChange={(value) => setValue("model_router_id", value)}>
								<SelectTrigger id="model-routing-rule-router" className="w-full" data-testid="model-routing-rule-router-select">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{routers.map((router) => (
										<SelectItem key={router.id} value={router.id} data-testid={`model-routing-rule-router-option-${router.id}`}>
											{router.name}
										</SelectItem>
									))}
									{/* A rule naming a router this list has not loaded keeps its value. */}
									{routerId && !routers.some((router) => router.id === routerId) && <SelectItem value={routerId}>{routerId}</SelectItem>}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">{tmr("routerHelp")}</p>
						</div>

						<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
							<RuleScopeSelect
								id="model-routing-rule-scope"
								value={scope}
								onChange={(value) => {
									setValue("scope", value);
									setValue("scope_id", "");
								}}
								testId="model-routing-rule-scope-select"
							/>
							<div className="space-y-3">
								<Label htmlFor="model-routing-rule-priority">
									{t("routing.priority")} <span className="text-red-500">*</span>
								</Label>
								<Input
									id="model-routing-rule-priority"
									type="number"
									min={0}
									max={1000}
									data-testid="model-routing-rule-priority-input"
									{...register("priority", {
										required: t("routing.priorityRequired"),
										min: { value: 0, message: t("routing.priorityMin") },
										max: { value: 1000, message: t("routing.priorityMax") },
										valueAsNumber: true,
									})}
								/>
								<p className="text-muted-foreground text-xs">{tmr("priorityHelp")}</p>
								{errors.priority && <p className="text-destructive text-sm">{errors.priority.message}</p>}
							</div>
						</div>

						{scope !== RoutingRuleScope.Global && (
							<RuleScopeEntityField
								scope={scope}
								value={scopeId}
								onChange={(value) => setValue("scope_id", value)}
								error={scopeError ?? undefined}
								userInputTestId="model-routing-rule-scope-user-input"
							/>
						)}

						<Separator />

						<div className="space-y-3">
							<Label>{tmr("conditionLabel")}</Label>
							<p className="text-muted-foreground text-sm">{tmr("conditionHelp")}</p>
							<CELRuleBuilder
								key={builderKey}
								initialQuery={query}
								onChange={handleQueryChange}
								providers={availableProviders}
								models={[]}
								allowCustomModels
								allowCelMode
								initialMode={conditionMode}
								initialCel={editingRule?.cel_expression ?? ""}
								onModeChange={handleModeChange}
								celError={celError}
								excludeFields={EXCLUDED_CEL_FIELDS}
							/>
						</div>

						<Separator />

						<div className="space-y-4">
							<div className="space-y-1">
								<Label>{tmr("targetsLabel")}</Label>
								<p className="text-muted-foreground text-sm">{tmr("targetsHelp")}</p>
							</div>
							{COMPLEXITY_TIER_VALUES.map((tier) => {
								const tierKey = tier.toLowerCase();
								const inTier = targets.map((target, index) => ({ target, index })).filter(({ target }) => target.tier === tier);
								return (
									<div key={tier} className="space-y-3 rounded-lg border p-4" data-testid={`model-routing-rule-tier-${tierKey}`}>
										<div className="flex items-center justify-between gap-3">
											<div>
												<p className="text-sm font-medium">{tmr(`tiers.${tier}`)}</p>
												{inTier.length === 0 && <p className="text-muted-foreground text-xs">{tmr("tierKeepsModel")}</p>}
											</div>
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => addTarget(tier)}
												data-testid={`model-routing-rule-tier-${tierKey}-add-button`}
											>
												<Plus className="size-3.5" />
												{tmr("addModel")}
											</Button>
										</div>
										{inTier.map(({ target, index }, position) => {
											const prefix = `model-routing-target-${tierKey}-${position}`;
											return (
												<div key={`${tier}-${index}`} className="space-y-2">
													<TargetRow
														target={target}
														index={position}
														idPrefix={prefix}
														referencedProviderOptions={referencedProviderOptions}
														allKeys={allKeysData}
														showRemove
														onUpdate={(_, field, value) => updateTarget(index, { [field]: value } as Partial<TierTargetFormData>)}
														onRemove={() => removeTarget(index)}
													/>
													<div className="ml-3 space-y-2 border-l pl-3">
														{target.fallbacks.map((fallback, fallbackIndex) => (
															<FallbackRow
																key={`${prefix}-fallback-${fallbackIndex}`}
																fallback={fallback}
																index={fallbackIndex}
																idPrefix={`${prefix}-fallback-${fallbackIndex}`}
																referencedProviderOptions={referencedProviderOptions}
																allKeys={allKeysData}
																onUpdate={(_, changes) =>
																	updateTarget(index, {
																		fallbacks: target.fallbacks.map((item, i) => (i === fallbackIndex ? { ...item, ...changes } : item)),
																	})
																}
																onRemove={() => updateTarget(index, { fallbacks: target.fallbacks.filter((_, i) => i !== fallbackIndex) })}
															/>
														))}
														<div className="flex flex-wrap items-center gap-3">
															<Button
																type="button"
																variant="ghost"
																size="sm"
																onClick={() => updateTarget(index, { fallbacks: [...target.fallbacks, { ...DEFAULT_ROUTING_FALLBACK }] })}
																data-testid={`${prefix}-add-fallback-button`}
															>
																<Plus className="size-3.5" />
																{t("routing.addFallback")}
															</Button>
															<div className="flex items-center gap-1.5">
																<Label htmlFor={`${prefix}-ttft-input`} className="text-muted-foreground shrink-0 text-xs">
																	{tmr("ttftLabel")}
																</Label>
																<Input
																	id={`${prefix}-ttft-input`}
																	inputMode="numeric"
																	placeholder={tmr("ttftPlaceholder")}
																	value={target.ttft}
																	onChange={(event) => updateTarget(index, { ttft: event.target.value })}
																	className="h-8 w-28 text-sm"
																	data-testid={`${prefix}-ttft-input`}
																/>
															</div>
														</div>
													</div>
												</div>
											);
										})}
										{targetErrors.tiers[tier] && (
											<p className="text-destructive text-sm" data-testid={`model-routing-rule-tier-${tierKey}-error`}>
												{targetErrors.tiers[tier]}
											</p>
										)}
									</div>
								);
							})}
							{targetErrors.form && (
								<p className="text-destructive text-sm" data-testid="model-routing-rule-targets-error">
									{targetErrors.form}
								</p>
							)}
						</div>
					</div>

					<div className="bg-card sticky bottom-0 flex justify-end gap-2 border-t px-4 py-3 md:px-8">
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="model-routing-rule-cancel-button">
							{tc("cancel")}
						</Button>
						<Button type="submit" disabled={isCreating || isUpdating} data-testid="model-routing-rule-save-button">
							{isEditing ? tc("save") : tmr("createButton")}
						</Button>
					</div>
				</form>
			</SheetContent>
		</Sheet>
	);
}