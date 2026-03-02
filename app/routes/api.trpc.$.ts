import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '../../src/server/routers/index';
import { createTRPCContext } from '../../src/server/trpc';
import type { LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';

function handleRequest(args: LoaderFunctionArgs | ActionFunctionArgs) {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: args.request,
    router: appRouter,
    createContext: createTRPCContext,
  });
}

export const loader = (args: LoaderFunctionArgs) => handleRequest(args);
export const action = (args: ActionFunctionArgs) => handleRequest(args);
