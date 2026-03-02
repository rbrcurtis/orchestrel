import { router } from '../trpc';
import { cardsRouter } from './cards';
import { claudeRouter } from './claude';
import { reposRouter } from './repos';
import { sessionsRouter } from './sessions';

export const appRouter = router({
  cards: cardsRouter,
  claude: claudeRouter,
  repos: reposRouter,
  sessions: sessionsRouter,
});

export type AppRouter = typeof appRouter;
