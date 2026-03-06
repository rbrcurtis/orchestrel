import { Outlet } from "react-router";

export default function BoardLayout() {
  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-950">
      <header className="shrink-0 px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Conductor</h1>
      </header>
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
