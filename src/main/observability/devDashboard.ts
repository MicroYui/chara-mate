import { createServer, type Server } from "node:http";

import type {
  RuntimeObservability,
  RuntimeTraceFilter,
} from "./runtimeObservability";
import { VoiceMetrics } from "../voice/voiceMetrics";
import {
  emptyProductMetricsSnapshot,
  type ProductMetricsReader,
} from "./productMetrics";

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>CharaMate Dev Dashboard</title>
<style>body{font:13px system-ui;margin:24px;color:#20242b;background:#f5f7fa}header{display:flex;justify-content:space-between;align-items:center}input{padding:7px;border:1px solid #ccd2dc;border-radius:6px}section{background:white;border:1px solid #dfe3ea;border-radius:10px;padding:14px;margin-top:14px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid #edf0f4;text-align:left;padding:7px;vertical-align:top}code{overflow-wrap:anywhere}.metrics{display:flex;gap:20px}.muted{color:#6b7280}</style></head>
<body><header><div><h1>CharaMate Dev Dashboard</h1><p class="muted">本次开发进程的只读 Run / Tool / Memory / Storage / Voice / Image trace。Token 为已报告部分；当前 trace 窗口的回执覆盖数不是 HTTP 请求数，缺失和失败调用仍可能产生用量。</p></div><input id="filter" placeholder="Run ID / Tool / status"></header>
<section><div class="metrics" id="metrics"></div></section><section><h2>Product domains</h2><div class="metrics" id="product"></div></section><section><h2>Voice</h2><div class="metrics" id="voice"></div></section><section><h2>Tools</h2><table><thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>p50</th><th>p95</th></tr></thead><tbody id="tools"></tbody></table></section>
<section><h2>Runs & traces</h2><table><thead><tr><th>Time</th><th>Type</th><th>Run</th><th>Tool</th><th>Status</th><th>Error</th><th>Duration</th></tr></thead><tbody id="traces"></tbody></table></section>
<script>const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); const metric=(label,value)=>'<span><strong>'+esc(value)+'</strong><br><small>'+esc(label)+'</small></span>'; async function render(){const q=document.querySelector('#filter').value.toLowerCase();const data=await fetch('/dev/api/events').then(r=>r.json());document.querySelector('#metrics').innerHTML=['runs','approvals','contextCompactions'].map(k=>metric(k,data[k])).concat(['inputTokens','cachedInputTokens','outputTokens'].map(k=>metric(k+' known ('+data.usageCoverage[k]+'/'+data.usageCoverage.reports+' reports)',data[k]))).join('');const p=data.product;document.querySelector('#product').innerHTML=[metric('memory.active',p.memory.active),metric('memory.pendingCandidates',p.memory.pendingCandidates),metric('memory.revisions',p.memory.revisions),metric('memory.rawUtf16Bytes',p.memory.canonical.rawUtf16Bytes),metric('memory.quoteUtf8Bytes',p.memory.canonical.quoteUtf8Bytes),metric('memory.presentSources',p.memory.canonical.presentSources),metric('memory.releasedSources',p.memory.canonical.releasedSources),metric('storage.sqliteAllocatedBytes',p.storage.sqliteAllocatedBytes),metric('storage.sqliteReclaimableBytes',p.storage.sqliteReclaimableBytes),metric('storage.attachmentBytes',p.storage.attachmentBytes),metric('storage.activityAssetBytes',p.storage.activityAssetBytes),metric('storage.territoryAssetBytes',p.storage.territoryAssetBytes),metric('image.packaged',p.image.assets.packaged),metric('image.generated',p.image.assets.generated),metric('image.edited',p.image.assets.edited),metric('image.readyCandidates',p.image.candidates.ready)].join('');document.querySelector('#voice').innerHTML=['sessions','turns','reconnects','disconnects','lateEventsDiscarded'].map(k=>metric(k,data.voice[k])).concat(['inputTokens','cachedInputTokens','outputTokens'].map(k=>metric(k+' known ('+data.voice.usageCoverage[k]+'/'+data.voice.usageCoverage.reports+' response observations)',data.voice.tokens[k]))).concat(['connection','firstTranscript','firstAudio','toolContinuation','truncateAcknowledgement'].map(k=>metric(k+' p50/p95 ('+esc(data.voice[k].count)+')',esc(data.voice[k].p50Ms)+' / '+esc(data.voice[k].p95Ms)+' ms'))).concat(['credential','microphone','ice','sdp','data_channel'].map(k=>metric(k+' p50/p95 ('+esc(data.voice.connectionStages[k].count)+')',esc(data.voice.connectionStages[k].p50Ms)+' / '+esc(data.voice.connectionStages[k].p95Ms)+' ms'))).join('');document.querySelector('#tools').innerHTML=data.tools.map(t=>'<tr><td><code>'+esc(t.toolName)+'</code></td><td>'+t.calls+'</td><td>'+t.errors+'</td><td>'+t.p50Ms+' ms</td><td>'+t.p95Ms+' ms</td></tr>').join('');document.querySelector('#traces').innerHTML=data.traces.filter(t=>JSON.stringify(t).toLowerCase().includes(q)).map(t=>'<tr><td>'+esc(t.at)+'</td><td>'+esc(t.type)+'</td><td><code>'+esc(t.runId)+'</code></td><td><code>'+esc(t.toolName)+'</code></td><td>'+esc(t.status)+'</td><td>'+esc(t.errorCode)+'</td><td>'+esc(t.durationMs??'')+'</td></tr>').join('')} document.querySelector('#filter').addEventListener('input',render); render();</script></body></html>`;

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

  constructor(
    private readonly observability: RuntimeObservability,
    private readonly voiceMetrics = new VoiceMetrics(),
    private readonly productMetrics: ProductMetricsReader = {
      snapshot: emptyProductMetricsSnapshot,
    },
  ) {}

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
          JSON.stringify({
            ...this.observability.snapshot(filterFromUrl(url)),
            product: this.productMetrics.snapshot(),
            voice: this.voiceMetrics.snapshot(),
          }),
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
