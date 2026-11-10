import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModelSelector } from "@/components/ui/modelSelector";
import { ProviderSelector } from "@/components/ui/providerSelector";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DecisionModelSelector, DecisionProviderSelector } from "@/components/ui/decisionModelSelector";
import {
	COMPLEXITY_TIER_VALUES,
	DEFAULT_DECISION_MODEL,
	DEFAULT_DECISION_PROVIDER,
	MAX_SUGGESTION_INSTRUCTIONS_CHARACTERS,
	MAX_SUGGESTION_LOOKBACK_DAYS,
	MAX_SUGGESTION_TIER_PROMPT_CHARACTERS,
	SUGGESTION_EVERY_OPTIONS,
	SUGGESTION_TIER_CLASSIFIERS,
	SUGGESTION_WEEKDAYS,
	SuggestionTierClassifier,
	SuggestionTierDefaults,
} from "@/lib/types/complexityRouter";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ModelProvider, ModelProviderName } from "@/lib/types/config";
import { DBKey } from "@/lib/types/governance";
import { LoaderCircle, RotateCcw, Save } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Control, Controller, FieldErrors, Path, UseFormRegister, UseFormSetValue, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { AnalyzerFormValues, suggestionScheduleUnit } from "../formSchema";
import { FieldLabel } from "./formPrimitives";
import { DecisionTierCard } from "./sections";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	control: Control<AnalyzerFormValues>;
	register: UseFormRegister<AnalyzerFormValues>;
	setValue: UseFormSetValue<AnalyzerFormValues>;
	errors: FieldErrors<AnalyzerFormValues>["suggestions"];
	canUpdate: boolean;
	// Chat-capable providers with a serving key, the same pool the llm
	// fallback picks from.
	chatProviders: ModelProvider[];
	// Every configured provider, for the decision-model pickers, which decide
	// for themselves which providers answer decisions.
	providers: ModelProvider[];
	// Every key, so the model list can be narrowed to what the chosen
	// provider's enabled keys may serve.
	keys: DBKey[];
	// The router's llm fallback and decision models: where an empty phrase or
	// tier model starts from when suggestions are turned on or the tier
	// classifier is switched. They are copied in, never followed.
	llmModel?: ModelChoice;
	decisionModel?: ModelChoice;
	defaultInstructions: string;
	defaultTierInstructions: string;
	// What this router's tier step sends while nothing is edited, rendered by
	// the gateway; undefined until the status endpoint answers.
	tierDefaults?: SuggestionTierDefaults;
	canSave: boolean;
	isSaving: boolean;
	onSave: () => void;
	submitError: string | null;
}

export interface ModelChoice {
	provider: string;
	model: string;
}

// IANA zones the browser knows, offered as suggestions in the timezone field.
function timezoneOptions(): string[] {
	const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
	try {
		return intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
	} catch {
		return [];
	}
}

// SuggestionSettingsSheet edits the suggestions block: whether traffic is
// sampled for suggestions, when runs happen, how much they cluster, and which
// model and instructions write the phrases. Its fields are part of the page's
// form, so Save here saves everything, as the other sheets do.
export default function SuggestionSettingsSheet({
	open,
	onOpenChange,
	control,
	register,
	setValue,
	errors,
	canUpdate,
	chatProviders,
	providers,
	keys,
	llmModel,
	decisionModel,
	defaultInstructions,
	defaultTierInstructions,
	tierDefaults,
	canSave,
	isSaving,
	onSave,
	submitError,
}: Props) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const { t: tCommon } = useTranslation("common");
	const every = useWatch({ control, name: "suggestions.every" });
	const enabled = useWatch({ control, name: "suggestions.enabled" });
	const phraseProvider = useWatch({ control, name: "suggestions.provider" });
	const phraseModel = useWatch({ control, name: "suggestions.model" });
	const tierClassifier = useWatch({ control, name: "suggestions.tier_classifier" });
	const tierProvider = useWatch({ control, name: "suggestions.tier_provider" });
	const tierModel = useWatch({ control, name: "suggestions.tier_model" });
	const unit = suggestionScheduleUnit(every);
	const zones = useMemo(timezoneOptions, []);
	// Memoized: the model pickers refetch whenever this array's identity changes.
	const tierKeyIds = useMemo(
		() => keys.filter((key) => key.provider === tierProvider && key.enabled !== false).map((key) => key.key_id),
		[keys, tierProvider],
	);
	// Stable, since the decision model picker selects a self-hosted provider's
	// first listed model from an effect.
	const selectTierModel = useCallback(
		(next: string) => setValue("suggestions.tier_model", next, { shouldDirty: true, shouldValidate: true }),
		[setValue],
	);
	const defaultTierModel = (classifier: SuggestionTierClassifier): ModelChoice => {
		if (classifier === "decision") {
			return decisionModel?.model ? decisionModel : { provider: DEFAULT_DECISION_PROVIDER, model: DEFAULT_DECISION_MODEL };
		}
		return { provider: phraseProvider, model: phraseModel };
	};
	// Turning suggestions on fills each empty model from the router once, so
	// both are named, visible and editable before the first run.
	const turnOn = () => {
		let provider = phraseProvider;
		let model = phraseModel;
		if (!provider && !model && llmModel?.model) {
			provider = llmModel.provider;
			model = llmModel.model;
			setValue("suggestions.provider", provider, { shouldDirty: true });
			setValue("suggestions.model", model, { shouldDirty: true });
		}
		if (!tierProvider && !tierModel) {
			const fill = tierClassifier === "decision" ? defaultTierModel("decision") : { provider, model };
			setValue("suggestions.tier_provider", fill.provider, { shouldDirty: true });
			setValue("suggestions.tier_model", fill.model, { shouldDirty: true });
		}
	};
	const disabled = !canUpdate;
	// Each message has a stable id that its control points at, only while the
	// error is shown.
	const errorId = (field: string) => `suggestions-${field}-error`;
	const fieldError = (field: string, message?: string) =>
		message ? (
			<p id={errorId(field)} className="text-destructive text-xs">
				{message}
			</p>
		) : null;
	const errorAria = (field: string, message?: string) => (message ? { "aria-invalid": true, "aria-describedby": errorId(field) } : {});

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex flex-col p-0" data-testid="complexity-suggestions-settings-sheet">
				<SheetHeader className="flex flex-col items-start gap-1 py-4" headerClassName="bg-card z-10 mb-0 border-b px-4 md:px-6">
					<SheetTitle>{t("settingsTitle")}</SheetTitle>
					<SheetDescription>{t("settingsDescription")}</SheetDescription>
				</SheetHeader>

				<div className="custom-scrollbar min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
					<div className="flex items-start justify-between gap-4">
						<div className="space-y-1">
							<FieldLabel htmlFor="suggestions-enabled">{t("enabledLabel")}</FieldLabel>
							<p className="text-muted-foreground text-xs leading-relaxed">{t("enabledDescription")}</p>
						</div>
						<Controller
							control={control}
							name="suggestions.enabled"
							render={({ field }) => (
								<Switch
									id="suggestions-enabled"
									data-testid="complexity-suggestions-enabled-switch"
									checked={field.value}
									onCheckedChange={(checked) => {
										field.onChange(checked);
										if (checked) turnOn();
									}}
									disabled={disabled}
								/>
							)}
						/>
					</div>

					<fieldset className="space-y-4" disabled={disabled}>
						<legend className="text-sm font-semibold">{t("captureHeading")}</legend>
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<FieldLabel htmlFor="suggestions-sample" tooltip={t("sampleTip")}>
									{t("sampleLabel")}
								</FieldLabel>
								<Input
									id="suggestions-sample"
									data-testid="complexity-suggestions-sample-input"
									type="number"
									step="0.1"
									min={0.1}
									max={100}
									{...errorAria("sample", errors?.sample_percent?.message)}
									{...register("suggestions.sample_percent", { valueAsNumber: true })}
								/>
								{fieldError("sample", errors?.sample_percent?.message)}
							</div>
							<div className="space-y-1.5">
								<FieldLabel htmlFor="suggestions-lookback" tooltip={t("lookbackTip")}>
									{t("lookbackLabel")}
								</FieldLabel>
								<Input
									id="suggestions-lookback"
									data-testid="complexity-suggestions-lookback-input"
									type="number"
									min={1}
									max={MAX_SUGGESTION_LOOKBACK_DAYS}
									{...errorAria("lookback", errors?.lookback_days?.message)}
									{...register("suggestions.lookback_days", { valueAsNumber: true })}
								/>
								{fieldError("lookback", errors?.lookback_days?.message)}
							</div>
						</div>
					</fieldset>

					<fieldset className="space-y-4" disabled={disabled}>
						<legend className="text-sm font-semibold">{t("scheduleHeading")}</legend>
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<FieldLabel htmlFor="suggestions-every">{t("everyLabel")}</FieldLabel>
								<Controller
									control={control}
									name="suggestions.every"
									render={({ field }) => (
										<Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
											<SelectTrigger id="suggestions-every" data-testid="complexity-suggestions-every-select" className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{SUGGESTION_EVERY_OPTIONS.map((option) => (
													<SelectItem key={option} value={option} data-testid={`complexity-suggestions-every-option-${option}`}>
														{t(`every.${option}`)}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									)}
								/>
							</div>
							{unit !== "h" && (
								<div className="space-y-1.5">
									<FieldLabel htmlFor="suggestions-at">{t("atLabel")}</FieldLabel>
									<Input
										id="suggestions-at"
										data-testid="complexity-suggestions-at-input"
										type="time"
										{...errorAria("at", errors?.at?.message)}
										{...register("suggestions.at")}
									/>
									{fieldError("at", errors?.at?.message)}
								</div>
							)}
							{unit === "w" && (
								<div className="space-y-1.5">
									<FieldLabel htmlFor="suggestions-weekday">{t("weekdayLabel")}</FieldLabel>
									<Controller
										control={control}
										name="suggestions.weekday"
										render={({ field }) => (
											<Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
												<SelectTrigger id="suggestions-weekday" data-testid="complexity-suggestions-weekday-select" className="w-full">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{SUGGESTION_WEEKDAYS.map((day) => (
														<SelectItem key={day} value={day}>
															{t(`weekday.${day}`)}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										)}
									/>
								</div>
							)}
							<div className="space-y-1.5">
								<FieldLabel htmlFor="suggestions-timezone" tooltip={t("timezoneTip")}>
									{t("timezoneLabel")}
								</FieldLabel>
								<Input
									id="suggestions-timezone"
									data-testid="complexity-suggestions-timezone-input"
									list="suggestions-timezones"
									autoComplete="off"
									{...errorAria("timezone", errors?.timezone?.message)}
									{...register("suggestions.timezone")}
								/>
								<datalist id="suggestions-timezones">
									{zones.map((zone) => (
										<option key={zone} value={zone} />
									))}
								</datalist>
								{fieldError("timezone", errors?.timezone?.message)}
							</div>
						</div>
						<p className="text-muted-foreground text-xs leading-relaxed">{unit === "h" ? t("scheduleHourlyHint") : t("scheduleHint")}</p>
					</fieldset>

					<fieldset className="space-y-4" disabled={disabled} data-testid="complexity-suggestions-phrase-section">
						<div className="space-y-1">
							<legend className="text-sm font-semibold">{t("phraseHeading")}</legend>
							<p className="text-muted-foreground text-xs leading-relaxed">{t("phraseDescription")}</p>
						</div>
						<ChatModelFields
							idPrefix="suggestions"
							testIdPrefix="complexity-suggestions"
							providerName="suggestions.provider"
							modelName="suggestions.model"
							control={control}
							setValue={setValue}
							chatProviders={chatProviders}
							keys={keys}
							providerError={errors?.provider?.message}
							modelError={errors?.model?.message}
							disabled={disabled}
						/>
						<PromptField
							name="suggestions.instructions"
							testIdPrefix="complexity-suggestions-instructions"
							heading={t("instructionsHeading")}
							description={t("instructionsDescription")}
							generatedText={defaultInstructions}
							generatedState="shipped"
							maxLength={MAX_SUGGESTION_INSTRUCTIONS_CHARACTERS}
							control={control}
							setValue={setValue}
							disabled={disabled}
							error={errors?.instructions?.message}
						/>
					</fieldset>

					<fieldset className="space-y-4 border-t pt-5" disabled={disabled} data-testid="complexity-suggestions-tier-section">
						<div className="space-y-1">
							<legend className="text-sm font-semibold">{t("tierHeading")}</legend>
							<p className="text-muted-foreground text-xs leading-relaxed">{t("tierDescription")}</p>
						</div>
						<div className="space-y-1.5">
							<FieldLabel
								htmlFor="suggestions-tier-classifier"
								tooltip={
									<span className="space-y-1.5">
										<span className="block">
											<b>{t("tierClassifier.llm")}</b>: {t("tierClassifierDescription.llm")}
										</span>
										<span className="block">
											<b>{t("tierClassifier.decision")}</b>: {t("tierClassifierDescription.decision")}
										</span>
									</span>
								}
							>
								{t("tierClassifierLabel")}
							</FieldLabel>
							<Controller
								control={control}
								name="suggestions.tier_classifier"
								render={({ field }) => (
									<Select
										value={field.value}
										onValueChange={(value) => {
											if (value === field.value) return;
											const next = value as SuggestionTierClassifier;
											field.onChange(next);
											// A model is only meaningful for the classifier that
											// picked it, so switching starts from that classifier's
											// default instead of carrying a chat model into a
											// decision-model picker or the reverse.
											const model = defaultTierModel(next);
											setValue("suggestions.tier_provider", model.provider, { shouldDirty: true });
											setValue("suggestions.tier_model", model.model, { shouldDirty: true, shouldValidate: true });
										}}
										disabled={disabled}
									>
										<SelectTrigger
											id="suggestions-tier-classifier"
											className="w-full"
											data-testid="complexity-suggestions-tier-classifier-select"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{SUGGESTION_TIER_CLASSIFIERS.map((value) => (
												<SelectItem key={value} value={value} data-testid={`complexity-suggestions-tier-classifier-option-${value}`}>
													{t(`tierClassifier.${value}`)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							/>
						</div>
						{tierClassifier === "decision" ? (
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-1.5">
									<FieldLabel htmlFor="suggestions-tier-provider">{t("providerLabel")}</FieldLabel>
									<Controller
										control={control}
										name="suggestions.tier_provider"
										render={({ field }) => (
											<DecisionProviderSelector
												inputId="suggestions-tier-provider"
												data-testid="complexity-suggestions-tier-provider-select"
												providers={providers}
												value={field.value || ""}
												onChange={(next, defaultModel) => {
													field.onChange(next);
													setValue("suggestions.tier_model", defaultModel, { shouldDirty: true, shouldValidate: true });
												}}
												disabled={disabled}
											/>
										)}
									/>
									{fieldError("tier-provider", errors?.tier_provider?.message)}
								</div>
								<div className="space-y-1.5">
									<FieldLabel htmlFor="suggestions-tier-model">{t("modelLabel")}</FieldLabel>
									<Controller
										control={control}
										name="suggestions.tier_model"
										render={({ field }) => (
											<DecisionModelSelector
												inputId="suggestions-tier-model"
												data-testid="complexity-suggestions-tier-model-select"
												providerName={tierProvider}
												provider={providers.find((candidate) => candidate.name === tierProvider)}
												keys={tierKeyIds}
												value={field.value ?? ""}
												onChange={selectTierModel}
												disabled={disabled}
											/>
										)}
									/>
									{fieldError("tier-model", errors?.tier_model?.message)}
								</div>
							</div>
						) : (
							<ChatModelFields
								idPrefix="suggestions-tier"
								testIdPrefix="complexity-suggestions-tier"
								providerName="suggestions.tier_provider"
								modelName="suggestions.tier_model"
								control={control}
								setValue={setValue}
								chatProviders={chatProviders}
								keys={keys}
								providerError={errors?.tier_provider?.message}
								modelError={errors?.tier_model?.message}
								disabled={disabled}
							/>
						)}
						{tierClassifier === "decision" ? (
							<>
								<PromptField
									name="suggestions.tier_instructions"
									testIdPrefix="complexity-suggestions-tier-instructions"
									heading={t("tierQuestionHeading")}
									description={t("tierInstructionsDescriptionDecision")}
									generatedText={defaultTierInstructions}
									generatedState="shipped"
									maxLength={MAX_SUGGESTION_INSTRUCTIONS_CHARACTERS}
									control={control}
									setValue={setValue}
									disabled={disabled}
									error={errors?.tier_instructions?.message}
								/>
								<div className="space-y-2" data-testid="complexity-suggestions-tier-criteria">
									<span className="text-xs font-medium">{t("tierCriteriaHeading")}</span>
									<p className="text-muted-foreground text-xs leading-relaxed">{t("tierCriteriaDescription")}</p>
									{tierDefaults ? (
										<div className="space-y-3">
											{COMPLEXITY_TIER_VALUES.map((tier) => (
												<DecisionTierCard
													key={tier}
													tier={tier}
													basePath="suggestions.tier_criteria"
													testIdPrefix="complexity-suggestions-tier-criteria"
													control={control}
													setValue={setValue}
													errors={errors?.tier_criteria?.[tier]}
													canUpdate={canUpdate}
													defaults={tierDefaults.criteria[tier]}
													allowEmptyLists
												/>
											))}
										</div>
									) : (
										<p className="text-muted-foreground flex items-center gap-2 text-xs">
											<LoaderCircle className="size-3.5 animate-spin" />
											{t("tierCriteriaLoading")}
										</p>
									)}
								</div>
							</>
						) : (
							<PromptField
								name="suggestions.tier_prompt"
								testIdPrefix="complexity-suggestions-tier-prompt"
								heading={t("tierInstructionsHeading")}
								description={t("tierInstructionsDescriptionLlm")}
								generatedText={tierDefaults?.prompt ?? ""}
								generatedState="generated"
								generatedHint={t("tierPromptGeneratedHint")}
								maxLength={MAX_SUGGESTION_TIER_PROMPT_CHARACTERS}
								control={control}
								setValue={setValue}
								disabled={disabled}
								error={errors?.tier_prompt?.message}
							/>
						)}
					</fieldset>

					{!enabled && (
						<p className="text-muted-foreground text-xs" data-testid="complexity-suggestions-disabled-note">
							{t("disabledNote")}
						</p>
					)}
					{submitError && (
						<div
							role="alert"
							className="border-destructive/40 bg-destructive/10 text-destructive rounded-sm border px-3 py-2 font-mono text-sm"
						>
							{submitError}
						</div>
					)}
				</div>

				<SheetFooter className="bg-card flex-row items-center justify-end gap-2 border-t px-6 py-4">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onOpenChange(false)}
						data-testid="complexity-suggestions-settings-close-button"
					>
						{tCommon("close")}
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={onSave}
						disabled={!canSave || isSaving}
						data-testid="complexity-suggestions-settings-save-button"
					>
						{isSaving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
						{t("saveSettings")}
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
interface ChatModelFieldsProps {
	idPrefix: string;
	testIdPrefix: string;
	providerName: "suggestions.provider" | "suggestions.tier_provider";
	modelName: "suggestions.model" | "suggestions.tier_model";
	control: Control<AnalyzerFormValues>;
	setValue: UseFormSetValue<AnalyzerFormValues>;
	chatProviders: ModelProvider[];
	keys: DBKey[];
	providerError?: string;
	modelError?: string;
	disabled: boolean;
}

// ChatModelFields picks a chat model: the provider from those with a serving
// key, then a model its enabled keys may serve.
function ChatModelFields({
	idPrefix,
	testIdPrefix,
	providerName,
	modelName,
	control,
	setValue,
	chatProviders,
	keys,
	providerError,
	modelError,
	disabled,
}: ChatModelFieldsProps) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const provider = useWatch({ control, name: providerName });
	// Memoized: ModelSelector refetches whenever this array's identity changes.
	const providerKeyIds = useMemo(
		() => keys.filter((key) => key.provider === provider && key.enabled !== false).map((key) => key.key_id),
		[keys, provider],
	);
	const isChatProvider = useCallback((candidate: ModelProvider) => chatProviders.some((p) => p.name === candidate.name), [chatProviders]);
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			<div className="space-y-1.5">
				<FieldLabel htmlFor={`${idPrefix}-provider`}>{t("providerLabel")}</FieldLabel>
				<Controller
					control={control}
					name={providerName}
					render={({ field }) => (
						<ProviderSelector
							inputId={`${idPrefix}-provider`}
							data-testid={`${testIdPrefix}-provider-select`}
							filter={isChatProvider}
							ariaInvalid={providerError ? true : undefined}
							ariaDescribedBy={providerError ? `${idPrefix}-provider-error` : undefined}
							value={field.value || ""}
							onChange={(value: string) => {
								if (value === field.value) return;
								field.onChange(value as ModelProviderName);
								setValue(modelName, "", { shouldDirty: true });
							}}
							disabled={disabled}
						/>
					)}
				/>
				{providerError && (
					<p id={`${idPrefix}-provider-error`} className="text-destructive text-xs">
						{providerError}
					</p>
				)}
			</div>
			<div className="space-y-1.5">
				<FieldLabel htmlFor={`${idPrefix}-model`}>{t("modelLabel")}</FieldLabel>
				<Controller
					control={control}
					name={modelName}
					render={({ field }) => (
						<ModelSelector
							inputId={`${idPrefix}-model`}
							data-testid={`${testIdPrefix}-model-select`}
							provider={provider || undefined}
							keys={providerKeyIds}
							ariaInvalid={modelError ? true : undefined}
							ariaDescribedBy={modelError ? `${idPrefix}-model-error` : undefined}
							value={field.value ?? ""}
							onChange={field.onChange}
							allowCustomModel
							placeholder={provider ? t("searchModel") : t("selectProviderFirst")}
							disabled={disabled || !provider}
						/>
					)}
				/>
				{modelError && (
					<p id={`${idPrefix}-model-error`} className="text-destructive text-xs">
						{modelError}
					</p>
				)}
			</div>
		</div>
	);
}

interface PromptFieldProps {
	name: Extract<Path<AnalyzerFormValues>, "suggestions.instructions" | "suggestions.tier_prompt" | "suggestions.tier_instructions">;
	testIdPrefix: string;
	heading: string;
	description: string;
	// The text a run sends while the field is empty: shipped, or generated
	// from the router. It is what the editor shows until it is edited.
	generatedText: string;
	generatedState: "shipped" | "generated";
	generatedHint?: string;
	maxLength: number;
	control: Control<AnalyzerFormValues>;
	setValue: UseFormSetValue<AnalyzerFormValues>;
	disabled: boolean;
	error?: string;
}

// PromptField edits one prompt. It always shows the text a run sends: the
// shipped or generated text while the field is empty, the edit once there is
// one. Editing stores the whole text, which is then sent exactly as written;
// the reset empties the field, so runs go back to the shipped or generated
// text.
function PromptField({
	name,
	testIdPrefix,
	heading,
	description,
	generatedText,
	generatedState,
	generatedHint,
	maxLength,
	control,
	setValue,
	disabled,
	error,
}: PromptFieldProps) {
	const { t } = useTranslation("models", { keyPrefix: "routing.complexityUi.suggestions" });
	const value = useWatch({ control, name });
	const edited = value.trim() !== "";
	const shown = edited ? value : generatedText;
	// suggestions.instructions -> suggestions-instructions-error, matching the
	// sheet's other field errors.
	const errorId = `${name.replace(/[._]/g, "-")}-error`;
	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium">{heading}</span>
					<Badge variant={edited ? "warning" : "secondary"} className="h-4 px-1.5 text-[10px]" data-testid={`${testIdPrefix}-state`}>
						{edited ? t("promptEdited") : generatedState === "generated" ? t("promptGenerated") : t("promptShipped")}
					</Badge>
				</div>
				{edited && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						data-testid={`${testIdPrefix}-reset-button`}
						onClick={() => setValue(name, "", { shouldDirty: true, shouldValidate: true })}
						disabled={disabled}
					>
						<RotateCcw className="size-3.5" />
						{generatedState === "generated" ? t("useGeneratedPrompt") : t("resetInstructions")}
					</Button>
				)}
			</div>
			<p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
			{!edited && generatedHint && <p className="text-muted-foreground text-xs leading-relaxed">{generatedHint}</p>}
			<Controller
				control={control}
				name={name}
				render={({ field }) => (
					<Textarea
						data-testid={`${testIdPrefix}-input`}
						rows={12}
						maxLength={maxLength}
						className={cn("font-mono text-xs", !edited && "text-muted-foreground")}
						value={shown}
						onChange={(event) => field.onChange(event.target.value)}
						onBlur={field.onBlur}
						disabled={disabled}
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? errorId : undefined}
					/>
				)}
			/>
			<p className="text-muted-foreground text-right font-mono text-[11px] tabular-nums">
				{t("instructionsCount", { n: shown.length, max: maxLength })}
			</p>
			{error && (
				<p id={errorId} className="text-destructive text-xs">
					{error}
				</p>
			)}
		</div>
	);
}