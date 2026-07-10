import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/use-auth";

type HealthState =
  | { status: "loading" }
  | { status: "ok"; service: string }
  | { status: "error" };

export function HomePage() {
  const { user, logout } = useAuth();
  const [health, setHealth] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/v1/health")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ service: string }>;
      })
      .then((data) => {
        if (!cancelled) setHealth({ status: "ok", service: data.service });
      })
      .catch(() => {
        if (!cancelled) setHealth({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">groundplan</h1>
        <p className="text-muted-foreground max-w-md text-balance">
          See your infrastructure. Review it. Shape it.
        </p>
      </div>

      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <span
          className={
            "inline-block size-2 rounded-full " +
            (health.status === "ok"
              ? "bg-green-500"
              : health.status === "error"
                ? "bg-red-500"
                : "bg-yellow-500")
          }
        />
        <span>
          {health.status === "loading" && "Checking API…"}
          {health.status === "ok" && `API connected — ${health.service}`}
          {health.status === "error" && "API unreachable"}
        </span>
      </div>

      <div className="flex flex-col items-center gap-3">
        <p className="text-sm">
          Signed in as{" "}
          <span className="font-medium">
            {user?.display_name ?? user?.email ?? "unknown"}
          </span>
        </p>
        <Button variant="outline" onClick={() => void logout()}>
          Sign out
        </Button>
      </div>
    </main>
  );
}
