import { type RouteConfig, route, index, layout } from '@react-router/dev/routes';

export default [
  layout('routes/board.tsx', [
    index('routes/board.index.tsx'),
    route('backlog', 'routes/board.backlog.tsx'),
    route('archive', 'routes/board.archive.tsx'),
  ]),
] satisfies RouteConfig;
