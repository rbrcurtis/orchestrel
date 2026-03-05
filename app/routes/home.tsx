import type { Route } from "./+types/home";
import { Board } from "~/components/Board";
import { ErrorBoundary } from "~/components/ErrorBoundary";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Conductor" },
    { name: "description", content: "Personal kanban board + Claude Code orchestration" },
  ];
}

export default function Home() {
  return (
    <ErrorBoundary>
      <Board />
    </ErrorBoundary>
  );
}
