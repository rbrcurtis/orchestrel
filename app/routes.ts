import { type RouteConfig, route, index } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/trpc/*", "routes/api.trpc.$.ts"),
] satisfies RouteConfig;
