import PageTitle from "@/components/pageTitle";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import ModelRouterDetailView from "./views/modelRouterDetailView";
import { ModelRoutersView } from "./views/modelRoutersView";
import { ModelRoutingRulesView } from "./views/modelRoutingRulesView";

const VIEWS = ["routers", "rules"] as const;

// ModelRoutersPage lists the model routers and the model routing rules that
// send requests to them, and opens one router's configuration when the URL
// names it.
export default function ModelRoutersPage() {
	const { t } = useTranslation("models", { keyPrefix: "routing.modelRouters" });
	const [urlState, setUrlState] = useQueryStates(
		{
			router: parseAsString,
			view: parseAsStringLiteral(VIEWS).withDefault("routers"),
			// The router page's own tab, cleared when leaving it.
			tab: parseAsString,
		},
		{ history: "push" },
	);
	// A router started fresh on this visit, which opens on its classifier choice.
	const [freshId, setFreshId] = useState<string | null>(null);

	if (urlState.router) {
		return (
			<ModelRouterDetailView
				key={urlState.router}
				routerId={urlState.router}
				onBack={() => setUrlState({ router: null, tab: null, view: "routers" })}
				onOpenRules={() => setUrlState({ router: null, tab: null, view: "rules" })}
				initialStep={urlState.router === freshId ? "classifier" : undefined}
			/>
		);
	}

	return (
		<div className="no-padding-parent mx-auto flex w-full min-w-0 flex-col gap-4 p-4">
			<PageTitle title={t("title")} beta>
				{t("pageDescription")}
			</PageTitle>
			<Tabs value={urlState.view} onValueChange={(value) => setUrlState({ view: value as (typeof VIEWS)[number] })}>
				<TabsList>
					<TabsTrigger value="routers" data-testid="model-routers-tab-routers">
						{t("tabRouters")}
					</TabsTrigger>
					<TabsTrigger value="rules" data-testid="model-routers-tab-rules">
						{t("tabRules")}
					</TabsTrigger>
				</TabsList>
			</Tabs>
			{urlState.view === "rules" ? (
				<ModelRoutingRulesView />
			) : (
				<ModelRoutersView
					onOpenRouter={(id, chooseClassifier) => {
						setFreshId(chooseClassifier ? id : null);
						void setUrlState({ router: id });
					}}
				/>
			)}
		</div>
	);
}