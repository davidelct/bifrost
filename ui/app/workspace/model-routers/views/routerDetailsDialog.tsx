import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { msg } from "@/lib/i18n/validationMessage";
import { getErrorMessage } from "@/lib/store";
import {
	useCreateModelRouterMutation,
	useGetModelRouterQuery,
	useResetModelRouterMutation,
	useUpdateModelRouterMutation,
} from "@/lib/store/apis/governanceApi";
import { DEFAULT_COMPLEXITY_ROUTER_ID, ModelRouter } from "@/lib/types/complexityRouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { RadioCards } from "./formPrimitives";
import { z } from "zod";

const START_OPTIONS = ["copy", "builtin"] as const;
type StartFrom = (typeof START_OPTIONS)[number];

const detailsSchema = z.object({
	name: z.string().trim().min(1, msg("validation.nameIsRequired")),
	description: z.string().trim(),
	startFrom: z.enum(START_OPTIONS),
});
type DetailsFormValues = z.infer<typeof detailsSchema>;

interface RouterDetailsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	// The router to rename; absent to create one.
	router?: ModelRouter;
	onCreated?: (id: string, startFrom: StartFrom) => void;
}

// RouterDetailsDialog creates a model router, or edits an existing one's name
// and description. A new router starts from the Default router's classifier
// settings, so it is usable at once, with either the Default router's phrase
// lists or the built-in ones: the gateway refuses empty phrase lists.
export default function RouterDetailsDialog({ open, onOpenChange, router, onCreated }: RouterDetailsDialogProps) {
	const { t } = useTranslation("models", { keyPrefix: "routing.modelRouters" });
	const { t: tc } = useTranslation("common");
	const isEdit = Boolean(router);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const { data: defaultRouter, isLoading: defaultLoading } = useGetModelRouterQuery(DEFAULT_COMPLEXITY_ROUTER_ID, {
		skip: !open || isEdit,
	});
	const [createRouter, { isLoading: isCreating }] = useCreateModelRouterMutation();
	const [resetRouter, { isLoading: isResetting }] = useResetModelRouterMutation();
	const [updateRouter, { isLoading: isUpdating }] = useUpdateModelRouterMutation();
	const isSaving = isCreating || isResetting || isUpdating;

	const form = useForm<DetailsFormValues>({
		resolver: zodResolver(detailsSchema),
		defaultValues: { name: "", description: "", startFrom: "copy" },
	});
	useEffect(() => {
		if (!open) return;
		setSubmitError(null);
		form.reset({ name: router?.name ?? "", description: router?.description ?? "", startFrom: "copy" });
	}, [open, router, form]);
	const startFrom = form.watch("startFrom");

	const create = async (values: DetailsFormValues) => {
		if (!defaultRouter) return;
		const config: Partial<ModelRouter> = { ...defaultRouter };
		delete config.id;
		const created = await createRouter({ ...config, name: values.name, description: values.description } as ModelRouter).unwrap();
		if (values.startFrom === "builtin") {
			try {
				await resetRouter(created.id).unwrap();
			} catch (err) {
				toast.warning(t("builtinResetFailed", { error: getErrorMessage(err) }), { position: "top-right" });
			}
		}
		toast.success(t("created"), { position: "top-right" });
		onCreated?.(created.id, values.startFrom);
	};

	const rename = async (values: DetailsFormValues) => {
		if (!router) return;
		await updateRouter({ ...router, name: values.name, description: values.description }).unwrap();
		toast.success(t("detailsSaved"), { position: "top-right" });
	};

	const onSubmit = form.handleSubmit((values) => {
		setSubmitError(null);
		(isEdit ? rename(values) : create(values))
			.then(() => onOpenChange(false))
			.catch((err) => setSubmitError(t(isEdit ? "detailsSaveFailed" : "createFailed", { error: getErrorMessage(err) })));
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg" data-testid="model-router-details-dialog">
				<DialogHeader>
					<DialogTitle>{isEdit ? t("editDetailsTitle") : t("newRouter")}</DialogTitle>
					<DialogDescription>{isEdit ? t("editDetailsDescription") : t("newRouterDescription")}</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form onSubmit={onSubmit} className="space-y-4" noValidate>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("nameLabel")}</FormLabel>
									<FormControl>
										<Input {...field} placeholder={t("namePlaceholder")} autoFocus data-testid="model-router-name-input" />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="description"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("descriptionLabel")}</FormLabel>
									<FormControl>
										<Textarea {...field} rows={2} placeholder={t("descriptionPlaceholder")} data-testid="model-router-description-input" />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						{!isEdit && (
							<div className="space-y-2">
								<p className="text-sm font-medium">{t("startFromLabel")}</p>
								<RadioCards
									value={startFrom}
									onChange={(option) => form.setValue("startFrom", option)}
									ariaLabel={t("startFromLabel")}
									testIdPrefix="model-router-start"
									options={START_OPTIONS.map((option) => ({
										value: option,
										title: t(option === "copy" ? "startCopyTitle" : "startBuiltinTitle"),
										description: t(option === "copy" ? "startCopyDescription" : "startBuiltinDescription"),
									}))}
								/>
							</div>
						)}
						{submitError && (
							<p className="text-destructive text-sm" role="alert" data-testid="model-router-details-error">
								{submitError}
							</p>
						)}
						<DialogFooter className="gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => onOpenChange(false)}
								data-testid="model-router-details-cancel-button"
							>
								{tc("cancel")}
							</Button>
							<Button
								type="submit"
								size="sm"
								disabled={isSaving || (!isEdit && (defaultLoading || !defaultRouter))}
								data-testid="model-router-details-submit-button"
							>
								{isSaving && <LoaderCircle className="size-3.5 animate-spin" />}
								{isEdit ? tc("save") : t("createRouter")}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}