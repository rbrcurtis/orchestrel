import { router } from '../trpc';
import { cardsRouter } from './cards';

export const appRouter = router({
  cards: cardsRouter,
});

export type AppRouter = typeof appRouter;
