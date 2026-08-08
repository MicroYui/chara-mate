import { createServer, type Server } from "node:http";

import type {
  RuntimeObservability,
  RuntimeTraceFilter,
} from "./runtimeObservability";

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>CharaMate Dev Dashboard</title>
<style>body{font:13px system-ui;margin:24px;color:#20242b;background:#f5f7fa}header{display:flex;justify-content:space-between;align-items:center}input{padding:7px;border:1px solid #ccd2dc;border-radius:6px}section{background:white;border:1px solid #dfe3ea;border-radius:10px;padding:14px;margin-top:14px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid #edf0f4;text-align:left;padding:7px;vertical-align:top}code{overflow-wrap:anywhere}.metrics{display:flex;gap:20px}.muted{color:#6b7280}</style></head>
<body><header><div><h1>CharaMate Dev Dashboard</h1><p class="muted">本次开发进程的只读 Run / Tool / Approval / Context trace</p></div><input id="filter" placeholder="Run ID / Tool / status"></header>
<section><div class="metrics" id="metrics"></div></section><section><h2>Tools</h2><table><thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>p50</th><th>p95</th></tr></thead><tbody id="tools"></tbody></table></section>
<section><h2>Runs & traces</h2><table><thead><tr><th>Time</th><th>Type</th><th>Run</th><th>Tool</th><th>Status</th><th>Error</th><th>Duration</th></tr></thead><tbody id="traces"></tbody></table></section>
<script>const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); async function render(){const q=document.querySelector('#filter').value.toLowerCase();const data=await fetch('/dev/api/events').then(r=>r.json());document.querySelector('#metrics').innerHTML=['runs','approvals','contextCompactions','inputTokens','cachedInputTokens','outputTokens'].map(k=>'<span><strong>'+esc(data[k])+'</strong><br><small>'+k+'</small></span>').join('');document.querySelector('#tools').innerHTML=data.tools.map(t=>'<tr><td><code>'+esc(t.toolName)+'</code></td><td>'+t.calls+'</td><td>'+t.errors+'</td><td>'+t.p50Ms+' ms</td><td>'+t.p95Ms+' ms</td></tr>').join('');document.querySelector('#traces').innerHTML=data.traces.filter(t=>JSON.stringify(t).toLowerCase().includes(q)).map(t=>'<tr><td>'+esc(t.at)+'</td><td>'+esc(t.type)+'</td><td><code>'+esc(t.runId)+'</code></td><td><code>'+esc(t.toolName)+'</code></td><td>'+esc(t.status)+'</td><td>'+esc(t.errorCode)+'</td><td>'+esc(t.durationMs??'')+'</td></tr>').join('')} document.querySelector('#filter').addEventListener('input',render); render();</script></body></html>`;

function filterFromUrl(url: URL): RuntimeTraceFilter {
  const value = (name: keyof RuntimeTraceFilter) =>
    url.searchParams.get(name)?.trim() || undefined;
  const chatId = value("chatId");
  const errorCode = value("errorCode");
  const modelId = value("modelId");
  const providerProfileId = value("providerProfileId");
  const runId = value("runId");
  const status = value("status");
  const toolName = value("toolName");
  return {
    ...(chatId ? { chatId } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(modelId ? { modelId } : {}),
    ...(providerProfileId ? { providerProfileId } : {}),
    ...(runId ? { runId } : {}),
    ...(status ? { status } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

export class DevDashboard {
  #server: Server | undefined;

  constructor(private readonly observability: RuntimeObservability) {}

  async start(): Promise<string> {
    if (this.#server) throw new Error("Dev Dashboard is already running");
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/dev/api/events") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify(this.observability.snapshot(filterFromUrl(url))),
        );
        return;
      }
      if (url.pathname === "/dev" || url.pathname === "/dev/") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        });
        response.end(DASHBOARD_HTML);
        return;
      }
      response.writeHead(404).end();
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Dev Dashboard did not receive a TCP port");
    }
    return `http://127.0.0.1:${String(address.port)}/dev`;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
