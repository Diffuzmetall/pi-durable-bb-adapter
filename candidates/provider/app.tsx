import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { PiDiagnosticsReport, ExtensionDiagnostic } from "./src/runner/diagnostics-types";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

function StatusBadge({ status }: { status: "healthy" | "warning" | "error" }) {
  const configs = {
    healthy: { label: "Operational", bg: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
    warning: { label: "Warnings", bg: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
    error: { label: "Error", bg: "bg-rose-500/10 text-rose-500 border-rose-500/20" },
  };
  const cfg = configs[status] ?? configs.warning;
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border", cfg.bg)}>
      {cfg.label}
    </span>
  );
}

function ExtensionRow({ ext }: { ext: ExtensionDiagnostic }) {
  const hasUnsupported = ext.unsupportedHooks.length > 0;
  return (
    <div className="p-3 rounded border border-border bg-card/50 space-y-2 text-xs">
      <div className="flex items-center justify-between font-mono">
        <span className="font-semibold text-foreground truncate max-w-[70%]">{ext.path}</span>
        {hasUnsupported ? (
          <span className="text-amber-500 text-[10px] uppercase font-bold tracking-wider">Partial Hooks</span>
        ) : (
          <span className="text-emerald-500 text-[10px] uppercase font-bold tracking-wider">Fully Compatible</span>
        )}
      </div>

      {ext.tools.length > 0 && (
        <div className="text-muted-foreground">
          <span className="text-foreground font-medium">Tools: </span>
          {ext.tools.join(", ")}
        </div>
      )}

      {ext.commands.length > 0 && (
        <div className="text-muted-foreground">
          <span className="text-foreground font-medium">Commands: </span>
          {ext.commands.join(", ")}
        </div>
      )}

      <div className="flex flex-wrap gap-1 items-center pt-1">
        <span className="text-muted-foreground mr-1">Hooks:</span>
        {ext.supportedHooks.map((h) => (
          <span key={h} className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 text-[10px]">
            ✓ {h}
          </span>
        ))}
        {ext.unsupportedHooks.map((h) => (
          <span key={h} className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 text-[10px]" title="Hook not supported in Durable Harness">
            ⚠ {h}
          </span>
        ))}
      </div>
    </div>
  );
}

function DoctorView() {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<PiDiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDiagnostics = useCallback(() => {
    setLoading(true);
    rpc
      .call("diagnostics_get")
      .then((res) => {
        setReport(res.report);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [rpc]);

  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-foreground">Pi Durable Doctor</h1>
            {report && <StatusBadge status={report.status} />}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Environment inspector, settings parity, and extension lifecycle compatibility audit.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchDiagnostics} disabled={loading} className="gap-2">
          <Icon name="RefreshCw" className={cn("size-3.5", loading && "animate-spin")} />
          {loading ? "Checking..." : "Re-run Probe"}
        </Button>
      </div>

      {error && (
        <div className="p-4 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive text-sm">
          Failed to load diagnostics: {error}
        </div>
      )}

      {report && (
        <>
          <div className="p-3.5 rounded-lg border border-border bg-card/60 flex items-center justify-between text-xs">
            <span className="text-foreground">{report.summary}</span>
            <div className="flex gap-3 text-muted-foreground font-mono">
              <span>Plugin: v{report.version}</span>
              <span>Durable: v{report.durableVersion}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Environment & Config Files</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs font-mono">
                <div className="text-muted-foreground truncate" title={report.agentDir}>
                  agentDir: <span className="text-foreground">{report.agentDir}</span>
                </div>
                {Object.entries(report.paths)
                  .filter(([k]) => k !== "agentDir")
                  .map(([name, p]) => (
                    <div key={name} className="flex items-center justify-between py-0.5 border-b border-border/40">
                      <span className="text-muted-foreground">{name}</span>
                      <span className={cn(p.exists ? "text-emerald-500 font-medium" : "text-muted-foreground")}>
                        {p.exists ? "FOUND" : "optional missing"}
                      </span>
                    </div>
                  ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Models & Settings Parity</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex justify-between py-0.5 border-b border-border/40">
                  <span className="text-muted-foreground">Default Model</span>
                  <span className="font-mono text-foreground font-medium">
                    {report.settings.defaultProvider}/{report.settings.defaultModel ?? "not configured"}
                  </span>
                </div>
                <div className="flex justify-between py-0.5 border-b border-border/40">
                  <span className="text-muted-foreground">Default Thinking</span>
                  <span className="font-mono text-foreground">{report.settings.thinkingLevel ?? "none"}</span>
                </div>
                <div className="flex justify-between py-0.5 border-b border-border/40">
                  <span className="text-muted-foreground">Authenticated Models</span>
                  <span className="font-mono text-foreground font-semibold">{report.models.total}</span>
                </div>
                <div className="flex justify-between py-0.5 border-b border-border/40">
                  <span className="text-muted-foreground">Active Packages</span>
                  <span className="font-mono text-foreground">{report.settings.packages.join(", ") || "none"}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-sm font-semibold">Extensions & Lifecycle Compatibility Matrix</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Audit of loaded extensions and their hooks against Pi Durable Harness.
                </p>
              </div>
              <span className="text-xs font-mono font-bold bg-muted px-2 py-0.5 rounded">
                {report.extensions.total} loaded
              </span>
            </CardHeader>
            <CardContent className="space-y-3">
              {report.extensions.items.length === 0 ? (
                <div className="text-xs text-muted-foreground py-4 text-center">No extensions discovered.</div>
              ) : (
                report.extensions.items.map((ext) => <ExtensionRow key={ext.path} ext={ext} />)
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Resolved Tools ({report.tools.total})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div>
                  <span className="text-muted-foreground">System Tools: </span>
                  <span className="font-mono text-foreground">{report.tools.system.join(", ")}</span>
                </div>
                {report.tools.mcp.length > 0 && (
                  <div>
                    <span className="text-muted-foreground">MCP Tools ({report.tools.mcp.length}): </span>
                    <span className="font-mono text-foreground">{report.tools.mcp.slice(0, 10).join(", ")}</span>
                    {report.tools.mcp.length > 10 && <span className="text-muted-foreground"> +{report.tools.mcp.length - 10} more</span>}
                  </div>
                )}
                {report.tools.custom.length > 0 && (
                  <div>
                    <span className="text-muted-foreground">Extension Tools ({report.tools.custom.length}): </span>
                    <span className="font-mono text-foreground">{report.tools.custom.join(", ")}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Discovered Skills ({report.skills.total})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <p className="text-muted-foreground">Skills formatted dynamically into Pi system prompt:</p>
                <div className="flex flex-wrap gap-1 font-mono text-[11px]">
                  {report.skills.sample.map((s) => (
                    <span key={s} className="px-1.5 py-0.5 rounded bg-muted text-foreground">
                      {s}
                    </span>
                  ))}
                  {report.skills.total > report.skills.sample.length && (
                    <span className="text-muted-foreground py-0.5">
                      +{report.skills.total - report.skills.sample.length} more
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

export default definePluginApp(DoctorView);
