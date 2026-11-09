import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { MCPSlugCodeMode } from "@/lib/types/mcp";

// id and aria-* come from FormControl so FormLabel targets the trigger.
interface SlugCodeModeSelectProps extends Pick<ComponentProps<typeof SelectTrigger>, "id" | "aria-describedby" | "aria-invalid"> {
	value: MCPSlugCodeMode | undefined;
	onChange: (value: MCPSlugCodeMode) => void;
	codeModeServer: boolean; // the Code Mode Server value "inherit" follows
	disabled?: boolean;
}

/** Picks code mode for one MCP server on its own /mcp/<slug> endpoint: the Code Mode Server setting, on, or off. */
export function SlugCodeModeSelect({ value, onChange, codeModeServer, disabled, ...triggerProps }: SlugCodeModeSelectProps) {
	const { t } = useTranslation("mcp");
	const options = [
		{
			value: "inherit",
			label: t("registry.form.slugCodeModeInherit", { value: codeModeServer ? t("common.enabled") : t("common.disabled") }),
		},
		{ value: "enabled", label: t("registry.form.slugCodeModeEnabled") },
		{ value: "disabled", label: t("registry.form.slugCodeModeDisabled") },
	] as const satisfies ReadonlyArray<{ value: MCPSlugCodeMode; label: string }>;
	return (
		<Select value={value ?? "inherit"} onValueChange={(v) => onChange(v as MCPSlugCodeMode)} disabled={disabled}>
			<SelectTrigger {...triggerProps} className="w-56" data-testid="mcp-client-slug-code-mode-select">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value} data-testid={`mcp-client-slug-code-mode-${option.value}`}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}