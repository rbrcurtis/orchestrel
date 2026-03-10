import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { TRPCProvider, makeTRPCClient } from '~/lib/trpc';
import { persister } from '~/lib/query-persist';

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0a0a0f" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <title>Dispatcher</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
        <script dangerouslySetInnerHTML={{ __html: `if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')` }} />
      </body>
    </html>
  );
}

// Prevent Vite from reloading the page when the HMR WebSocket reconnects
// after iOS suspends the PWA. The reload is triggered at
// node_modules/vite/dist/client/client.mjs:870 after notifyListeners resolves.
// Returning a never-resolving promise from our listener causes Promise.allSettled
// to hang, so the reload code is never reached.
if (import.meta.hot) {
  const sendLog = (msg: string) => {
    navigator.sendBeacon('/api/pwa-log', JSON.stringify({ msg, ts: new Date().toISOString() }));
  };
  sendLog('hmr client initialized');
  import.meta.hot.on('vite:ws:disconnect', () => {
    sendLog('vite:ws:disconnect intercepted, blocking reload');
    return new Promise(() => {});
  });
  import.meta.hot.on('vite:ws:connect', () => {
    sendLog('vite:ws:connect');
  });
  import.meta.hot.on('vite:beforeFullReload', () => {
    sendLog('vite:beforeFullReload triggered');
  });
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { gcTime: Infinity } },
});
const trpcClient = makeTRPCClient();

export default function App() {
  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 }}
      >
        <Outlet />
      </PersistQueryClientProvider>
    </TRPCProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
