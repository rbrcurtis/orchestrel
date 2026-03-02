import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Dispatch" },
    { name: "description", content: "Personal kanban board + Claude Code orchestration" },
  ];
}

export default function Home() {
  return (
    <main className="flex items-center justify-center min-h-screen">
      <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100">
        Dispatch
      </h1>
    </main>
  );
}
