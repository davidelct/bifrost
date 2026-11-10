import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage, useGetEvalDatasetRowsQuery, useGetEvalDatasetsQuery, useLazyGetEvalDatasetRowVariablesQuery } from "@/lib/store";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// How many rows the row picker offers. It is a way to grab a sample, not to browse.
const ROW_CHOICES = 100;

// LoadFromDataset fills an evaluator's test inputs from one dataset row. It calls
// onLoad with the variables that row produces.
export function LoadFromDataset({ onLoad }: { onLoad: (variables: Record<string, string>) => void }) {
	const { t } = useTranslation("config");
	const { t: tCommon } = useTranslation("common");
	const { toast } = useToast();
	const { data: datasetsData } = useGetEvalDatasetsQuery({ limit: 200 });
	const datasets = datasetsData?.datasets ?? [];
	const [datasetId, setDatasetId] = useState("");
	const [rowId, setRowId] = useState("");
	const { data: rowsData } = useGetEvalDatasetRowsQuery({ id: datasetId, limit: ROW_CHOICES }, { skip: !datasetId });
	const [fetchVariables, { isFetching }] = useLazyGetEvalDatasetRowVariablesQuery();

	useEffect(() => setRowId(""), [datasetId]);

	// Nothing to load from: the control stays out of the way.
	if (datasets.length === 0) return null;

	const fill = async () => {
		try {
			const result = await fetchVariables({ id: datasetId, rowId }).unwrap();
			onLoad(result.variables);
		} catch (error) {
			toast({ title: tCommon("error"), description: getErrorMessage(error), variant: "destructive" });
		}
	};

	return (
		<div className="flex flex-wrap items-end gap-2 rounded-sm border p-3" data-testid="evaluator-test-load-from-dataset">
			<div className="flex min-w-36 flex-1 flex-col gap-1.5">
				<Label htmlFor="load-dataset" className="text-xs">
					{t("evals.datasets.load.label")}
				</Label>
				<Select value={datasetId} onValueChange={setDatasetId}>
					<SelectTrigger id="load-dataset" data-testid="evaluator-test-load-dataset-select">
						<SelectValue placeholder={t("evals.datasets.addTo.pickDataset")} />
					</SelectTrigger>
					<SelectContent>
						{datasets.map((dataset) => (
							<SelectItem key={dataset.id} value={dataset.id}>
								{dataset.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="flex min-w-36 flex-1 flex-col gap-1.5">
				<Label htmlFor="load-row" className="text-xs">
					{t("evals.datasets.load.row")}
				</Label>
				<Select value={rowId} onValueChange={setRowId} disabled={!datasetId}>
					<SelectTrigger id="load-row" data-testid="evaluator-test-load-row-select">
						<SelectValue placeholder={t("evals.datasets.load.pickRow")} />
					</SelectTrigger>
					<SelectContent>
						{(rowsData?.rows ?? []).map((row, index) => (
							<SelectItem key={row.id} value={row.id}>
								<span className="block max-w-64 truncate">
									{index + 1} · {Object.values(row.cells)[0] ?? ""}
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<Button variant="outline" disabled={!rowId || isFetching} onClick={() => void fill()} data-testid="evaluator-test-load-fill-btn">
				{t("evals.datasets.load.fill")}
			</Button>
		</div>
	);
}