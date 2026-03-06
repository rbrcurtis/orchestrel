import { type RouteConfig, route, index, layout } from "@react-router/dev/routes";

export default [
  layout("routes/board.tsx", [
    index("routes/board.index.tsx"),
    route("backlog", "routes/board.backlog.tsx"),
    route("done", "routes/board.done.tsx"),
  ]),
  route("api/trpc/*", "routes/api.trpc.$.ts"),
  route("settings/repos", "routes/settings.repos.tsx"),
] satisfies RouteConfig;
