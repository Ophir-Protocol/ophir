import express from 'express';
import { OphirRouter, createRouterAPI } from '@ophirai/router';
import type { RouterConfig } from '@ophirai/router';

export interface GatewayConfig extends RouterConfig {
  port?: number;
}

const startedAt = Date.now();
let totalNegotiations = 0;

function renderLandingPage(providerCount: number): string {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const uptimeStr =
    uptime < 60
      ? `${uptime}s`
      : uptime < 3600
        ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
        : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ophir Inference Gateway</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      background: #0a0a0f;
      color: #e0e0e8;
      line-height: 1.6;
      min-height: 100vh;
    }
    .container { max-width: 860px; margin: 0 auto; padding: 60px 24px; }
    h1 {
      font-size: 2.4rem;
      font-weight: 700;
      background: linear-gradient(135deg, #6ee7b7, #3b82f6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }
    .tagline { font-size: 1.1rem; color: #9ca3af; margin-bottom: 48px; }
    .status-bar {
      display: flex;
      gap: 32px;
      flex-wrap: wrap;
      margin-bottom: 48px;
      padding: 20px 24px;
      background: #12121a;
      border: 1px solid #1e1e2e;
      border-radius: 12px;
    }
    .status-item { display: flex; align-items: center; gap: 8px; }
    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 6px #22c55e88;
    }
    .dot.inactive { background: #6b7280; box-shadow: none; }
    .status-label { font-size: 0.85rem; color: #9ca3af; }
    .status-value { font-size: 0.85rem; font-weight: 600; color: #e0e0e8; }
    h2 {
      font-size: 1.3rem;
      font-weight: 600;
      color: #e0e0e8;
      margin-bottom: 16px;
      margin-top: 40px;
    }
    pre {
      background: #12121a;
      border: 1px solid #1e1e2e;
      border-radius: 10px;
      padding: 20px;
      overflow-x: auto;
      font-size: 0.88rem;
      line-height: 1.7;
      margin-bottom: 16px;
    }
    code { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; }
    .lang-tab {
      display: inline-block;
      padding: 4px 12px;
      font-size: 0.75rem;
      font-weight: 600;
      color: #6ee7b7;
      background: #1a2e23;
      border-radius: 6px 6px 0 0;
      margin-bottom: -1px;
      position: relative;
      top: 1px;
    }
    .kw { color: #c084fc; }
    .str { color: #6ee7b7; }
    .fn { color: #60a5fa; }
    .cm { color: #6b7280; }
    .links {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      margin-top: 40px;
    }
    .links a {
      color: #60a5fa;
      text-decoration: none;
      font-size: 0.9rem;
      padding: 8px 16px;
      border: 1px solid #1e1e2e;
      border-radius: 8px;
      transition: border-color 0.2s;
    }
    .links a:hover { border-color: #3b82f6; }
    .footer {
      margin-top: 60px;
      padding-top: 24px;
      border-top: 1px solid #1e1e2e;
      font-size: 0.8rem;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Ophir Inference Gateway</h1>
    <p class="tagline">Drop-in OpenAI replacement with automatic provider negotiation</p>

    <div class="status-bar">
      <div class="status-item">
        <span class="dot"></span>
        <span class="status-label">Gateway</span>
        <span class="status-value">Live</span>
      </div>
      <div class="status-item">
        <span class="dot ${providerCount > 0 ? '' : 'inactive'}"></span>
        <span class="status-label">Providers</span>
        <span class="status-value">${providerCount}</span>
      </div>
      <div class="status-item">
        <span class="status-label">Negotiations</span>
        <span class="status-value">${totalNegotiations}</span>
      </div>
      <div class="status-item">
        <span class="status-label">Uptime</span>
        <span class="status-value">${uptimeStr}</span>
      </div>
    </div>

    <h2>Quick Start</h2>

    <span class="lang-tab">Python</span>
    <pre><code><span class="kw">from</span> openai <span class="kw">import</span> OpenAI

client = OpenAI(
    base_url=<span class="str">"https://api.ophir.ai/v1"</span>,
    api_key=<span class="str">"unused"</span>  <span class="cm"># no key needed</span>
)

response = client.<span class="fn">chat</span>.completions.<span class="fn">create</span>(
    model=<span class="str">"auto"</span>,
    messages=[{<span class="str">"role"</span>: <span class="str">"user"</span>, <span class="str">"content"</span>: <span class="str">"Hello!"</span>}]
)</code></pre>

    <span class="lang-tab">TypeScript</span>
    <pre><code><span class="kw">import</span> OpenAI <span class="kw">from</span> <span class="str">'openai'</span>;

<span class="kw">const</span> client = <span class="kw">new</span> <span class="fn">OpenAI</span>({
  baseURL: <span class="str">'https://api.ophir.ai/v1'</span>,
  apiKey: <span class="str">'unused'</span>,
});

<span class="kw">const</span> response = <span class="kw">await</span> client.chat.completions.<span class="fn">create</span>({
  model: <span class="str">'auto'</span>,
  messages: [{ role: <span class="str">'user'</span>, content: <span class="str">'Hello!'</span> }],
});</code></pre>

    <span class="lang-tab">curl</span>
    <pre><code>curl https://api.ophir.ai/v1/chat/completions \\
  -H <span class="str">"Content-Type: application/json"</span> \\
  -d <span class="str">'{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</span></code></pre>

    <div class="links">
      <a href="https://github.com/Ophir-Protocol/ophir">GitHub</a>
      <a href="https://docs.ophir.ai">Documentation</a>
      <a href="/.well-known/ophir.json">Discovery</a>
      <a href="/.well-known/agent.json">Agent Card</a>
      <a href="/health">Health</a>
    </div>

    <div class="footer">
      Powered by the Ophir Protocol &mdash; decentralized AI inference negotiation
    </div>
  </div>
</body>
</html>`;
}

export function createGateway(config?: GatewayConfig) {
  const { port = 8420, ...routerConfig } = config ?? {};

  const router = new OphirRouter(routerConfig);
  const app = express();

  app.use(express.json());

  // Landing page
  app.get('/', (_req, res) => {
    const monitor = router.getMonitor();
    const providerCount = monitor.getAgreementIds().length;
    res.type('html').send(renderLandingPage(providerCount));
  });

  // Health endpoint
  app.get('/health', (_req, res) => {
    const monitor = router.getMonitor();
    const agreementIds = monitor.getAgreementIds();
    const violations = monitor.getViolations();

    const agreements: Record<string, unknown> = {};
    for (const id of agreementIds) {
      agreements[id] = monitor.getStats(id);
    }

    res.json({
      status: 'ok',
      version: '0.2.0',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      providers: {
        connected: agreementIds.length,
        with_violations: violations.length,
      },
      negotiations: { total: totalNegotiations },
      agreements: {
        active: agreementIds.length,
        details: agreements,
      },
    });
  });

  // Well-known discovery
  app.get('/.well-known/ophir.json', (_req, res) => {
    res.json({
      ophir_version: '0.1.0',
      gateway: true,
      endpoint: 'https://api.ophir.ai',
      capabilities: {
        openai_compatible: true,
        automatic_negotiation: true,
        sla_monitoring: true,
        multi_provider: true,
        streaming: false,
      },
      supported_services: ['inference'],
      protocol: 'ophir/1.0',
    });
  });

  // A2A agent card
  app.get('/.well-known/agent.json', (_req, res) => {
    res.json({
      name: 'Ophir Inference Gateway',
      description: 'OpenAI-compatible inference gateway with automatic provider negotiation via the Ophir protocol',
      version: '0.2.0',
      protocol: 'a2a/1.0',
      capabilities: ['inference', 'negotiation', 'sla-monitoring'],
      endpoints: {
        chat_completions: '/v1/chat/completions',
        models: '/v1/models',
        health: '/health',
        discovery: '/.well-known/ophir.json',
      },
      provider: {
        name: 'Ophir',
        url: 'https://ophir.ai',
      },
    });
  });

  // Mount router API (handles /v1/chat/completions, /v1/models, etc.)
  app.use(createRouterAPI(router));

  let server: ReturnType<typeof app.listen> | null = null;

  return {
    app,
    router,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(port, () => {
          console.log(`Ophir Gateway listening on port ${port}`);
          resolve();
        });
        server.on('error', reject);
      });
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    },
  };
}

// CLI entry point
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const port = parseInt(process.env.PORT || '8420', 10);
  const gateway = createGateway({ port });
  gateway.start();
}

export default createGateway;
