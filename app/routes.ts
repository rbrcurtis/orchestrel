import { type RouteConfig, route, index, layout } from '@react-router/dev/routes';

export default [
  layout('routes/board.tsx', [
    index('routes/board.index.tsx'),
    route('backlog', 'routes/board.backlog.tsx'),
    route('archive', 'routes/board.archive.tsx'),
  ]),
  layout('routes/chat.tsx', [
    route('chat', 'routes/chat.index.tsx'),
    route('chat/:projectId', 'routes/chat.$projectId.tsx'),
    route('chat/:projectId/:cardId', 'routes/chat.$projectId.$cardId.tsx'),
  ]),
] satisfies RouteConfig;
