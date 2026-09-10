#!/usr/bin/env node
// Serves the in-memory fake Lakeday over HTTP for manual end-to-end runs.
//   node tests/serve-fake-lakeday.mjs [port]   → GET /__debug lists objects and events
import http from "node:http";
import { createFakeLakeday } from "./fake-lakeday.mjs";

const lake = createFakeLakeday();
const port = Number(process.argv[2] ?? 8790);
const server = http.createServer(async (req, res) => {
  const url = `http://127.0.0.1:${port}${req.url}`;
  if (req.url === "/__debug") {
    const out = {};
    for (const [key, entry] of lake.objects) out[key] = entry.events.map((e) => ({ type: e.type, data: e.data }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ requests: lake.requests, objects: out }, null, 2));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const response = await lake.fetch(url, { method: req.method, headers: req.headers, body: body || undefined });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});
server.listen(port, () => console.log(`fake lakeday on http://127.0.0.1:${port} (auth: Bearer test-key, tenant acme-test)`));
