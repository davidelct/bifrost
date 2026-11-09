import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Check, Info } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

// A tap is neither a hover nor a keyboard focus, so a Radix tooltip never opens
// on a touch device. Coarse pointers get the same copy from a popover instead.
function useCoarsePointer() {
	const [isCoarse, setIsCoarse] = useState(false);
	useEffect(() => {
		const query = window.matchMedia("(pointer: coarse)");
		const sync = () => setIsCoarse(query.matches);
		sync();
		query.addEventListener("change", sync);
		return () => query.removeEventListener("change", sync);
	}, []);
	return isCoarse;
}

// InfoTip carries the explanation that used to sit under a field, so the page
// reads as a form rather than as documentation.
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
	const isCoarsePointer = useCoarsePointer();
	const trigger = (
		<button type="button" aria-label={label} className="text-muted-foreground/70 hover:text-foreground transition-colors">
			<Info className="size-3.5" />
		</button>
	);

	if (isCoarsePointer) {
		return (
			<Popover>
				<PopoverTrigger asChild>{trigger}</PopoverTrigger>
				<PopoverContent className="w-auto max-w-xs p-3 text-xs leading-relaxed">{children}</PopoverContent>
			</Popover>
		);
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>{trigger}</TooltipTrigger>
			<TooltipContent className="max-w-xs leading-relaxed">{children}</TooltipContent>
		</Tooltip>
	);
}

export function FieldLabel({ htmlFor, children, tooltip }: { htmlFor?: string; children: ReactNode; tooltip?: ReactNode }) {
	const { t } = useTranslation("common");
	const fieldName = typeof children === "string" ? children : t("thisField");
	return (
		<div className="flex items-center gap-1.5">
			<Label htmlFor={htmlFor}>{children}</Label>
			{tooltip && <InfoTip label={t("aboutField", { field: fieldName })}>{tooltip}</InfoTip>}
		</div>
	);
}

export function SectionHeading({ title, description, aside }: { title: string; description?: string; aside?: ReactNode }) {
	return (
		<div className={cn("flex flex-wrap justify-between gap-2", description ? "items-start" : "items-center")}>
			<div className="space-y-1">
				<h2 className="text-sm font-semibold">{title}</h2>
				{description && <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">{description}</p>}
			</div>
			{aside}
		</div>
	);
}

export interface RadioCardOption<T extends string> {
	value: T;
	title: string;
	description: string;
	icon?: ReactNode;
}

// RadioCards shows a choice as explained cards rather than a dropdown, for a
// decision worth reading about before making it.
export function RadioCards<T extends string>({
	value,
	options,
	onChange,
	ariaLabel,
	testIdPrefix,
}: {
	value: T | undefined;
	options: RadioCardOption<T>[];
	onChange: (value: T) => void;
	ariaLabel: string;
	// Each card's test id is the prefix and its value, e.g. "<prefix>-semantic".
	testIdPrefix: string;
}) {
	return (
		<div role="radiogroup" aria-label={ariaLabel} className="grid gap-3 sm:grid-cols-2">
			{options.map((option) => {
				const selected = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={selected}
						onClick={() => onChange(option.value)}
						data-testid={`${testIdPrefix}-${option.value}`}
						className={cn(
							"hover:bg-accent/50 flex h-full flex-col gap-2 rounded-md border p-4 text-left transition-colors",
							selected && "border-primary bg-primary/5",
						)}
					>
						<div className="flex w-full items-center gap-2">
							{option.icon}
							<span className="text-sm font-medium">{option.title}</span>
							{selected && <Check className="ml-auto size-4 text-green-600" />}
						</div>
						<p className="text-muted-foreground text-xs leading-relaxed">{option.description}</p>
					</button>
				);
			})}
		</div>
	);
}