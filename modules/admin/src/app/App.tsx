import { useQuery } from "@tanstack/react-query";
import { Inbox, LogOut, Moon, Settings, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { queries, useApi } from "@/app/api";
import { useAuth } from "@/app/auth";
import { RequestDetailPage } from "@/app/pages/request-detail";
import { RequestsPage } from "@/app/pages/requests";
import { SettingsPage } from "@/app/pages/settings";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem("pw-admin-theme");
      if (saved) return saved === "dark";
    } catch {}
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("pw-admin-theme", dark ? "dark" : "light");
    } catch {}
  }, [dark]);
  return { dark, toggle: () => setDark((value) => !value) };
}

const NAV = [
  { to: "/requests", label: "Requests", icon: Inbox },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function App() {
  const api = useApi();
  const auth = useAuth();
  const theme = useTheme();
  const me = useQuery(queries.me(api));
  const who = me.data?.email ?? me.data?.name ?? me.data?.sub ?? "";

  return (
    <div className="min-h-screen md:grid md:grid-cols-[13.5rem_1fr]">
      <aside className="bg-rail text-rail-foreground md:sticky md:top-0 md:flex md:h-screen md:flex-col">
        <div className="flex items-center justify-between px-4 py-3 md:block md:px-5 md:py-6">
          <p className="text-[0.95rem] font-semibold tracking-tight">
            PressW Support
          </p>
          <p className="hidden text-xs text-rail-foreground/60 md:block">
            Request desk
          </p>
        </div>
        <nav
          aria-label="Primary"
          className="flex gap-1 px-2 pb-2 md:flex-col md:px-3"
        >
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-white/10 text-white"
                    : "text-rail-foreground/70 hover:bg-white/5 hover:text-white",
                )
              }
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden space-y-2 border-t border-white/10 p-4 md:block">
          <p className="truncate text-xs text-rail-foreground/70" title={who}>
            {who}
          </p>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-rail-foreground hover:bg-white/10 hover:text-white"
              onClick={() => void auth.logout()}
            >
              <LogOut aria-hidden="true" /> Sign out
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={theme.dark ? "Use light theme" : "Use dark theme"}
              className="text-rail-foreground hover:bg-white/10 hover:text-white"
              onClick={theme.toggle}
            >
              {theme.dark ? (
                <Sun aria-hidden="true" />
              ) : (
                <Moon aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/requests" replace />} />
          <Route path="/requests" element={<RequestsPage />} />
          <Route path="/requests/:id" element={<RequestDetailPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/requests" replace />} />
        </Routes>
        <div className="mt-8 flex gap-2 md:hidden">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void auth.logout()}
          >
            Sign out
          </Button>
          <Button variant="outline" size="sm" onClick={theme.toggle}>
            {theme.dark ? "Light theme" : "Dark theme"}
          </Button>
        </div>
      </main>
    </div>
  );
}
