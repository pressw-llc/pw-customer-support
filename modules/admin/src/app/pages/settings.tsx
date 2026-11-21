import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { IntegrationsPanel } from "@/app/pages/integrations-panel";
import { ProjectsPanel } from "@/app/pages/projects-panel";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/settings/projects", label: "Projects" },
  { to: "/settings/integrations", label: "Integrations" },
];

export function SettingsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Projects, their keys, and the services the desk connects to.
        </p>
      </header>
      <nav aria-label="Settings sections" className="flex gap-1 border-b">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                "-mb-px border-b-2 px-3 py-2 text-sm outline-none transition-colors focus-visible:bg-accent",
                isActive
                  ? "border-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Navigate to="projects" replace />} />
        <Route path="projects" element={<ProjectsPanel />} />
        <Route path="integrations" element={<IntegrationsPanel />} />
      </Routes>
    </div>
  );
}
