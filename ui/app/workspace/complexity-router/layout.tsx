import { createFileRoute, redirect } from "@tanstack/react-router";

// The complexity router is now the default model router. Links to its old
// page open that router, keeping the tab they asked for.
export const Route = createFileRoute("/workspace/complexity-router")({
	beforeLoad: ({ location }) => {
		const tab = new URLSearchParams(location.searchStr).get("tab");
		const search = new URLSearchParams({ router: "default", ...(tab ? { tab } : {}) });
		throw redirect({ href: `/workspace/model-routers?${search.toString()}`, replace: true });
	},
});