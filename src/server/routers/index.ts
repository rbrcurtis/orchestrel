import { router } from '../trpc';
import { cardsRouter } from './cards';
import { claudeRouter } from './claude';
import { projectsRouter } from './projects';
import { sessionsRouter } from './sessions';

export const appRouter = router({
  cards: cardsRouter,
  claude: claudeRouter,
  projects: projectsRouter,
  sessions: sessionsRouter,
});

export type AppRouter = typeof appRouter;
