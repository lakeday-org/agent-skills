// In-memory Lakeday for hook tests. Implements just enough of the OS API,
// public Entity/Session routes, and the Query route to exercise the hooks.

export function createFakeLakeday({ tenant = "acme-test", prefix = "u1_" } = {}) {
  const objects = new Map(); // `${kind}:${id}` -> { head, events: [] }
  const requests = [];
  const keys = new Map();
  let sqlHandler = () => ({ columns: [], rows: [] });

  const actor = `${prefix}user`;

  function object(kind, id) {
    return objects.get(`${kind}:${id}`) ?? null;
  }

  function commit(kind, id, type, data, actorId) {
    let entry = object(kind, id);
    if (!entry) {
      entry = { head: { id, kind, sequence: 0 }, events: [] };
      objects.set(`${kind}:${id}`, entry);
    }
    entry.head.sequence += 1;
    const event = { type, sequence: entry.head.sequence, timestamp: new Date().toISOString(), actor_id: actorId, data };
    entry.events.push(event);
    return event;
  }

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function historyResponse(entry, url, filter) {
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const events = entry.events.filter((e) => e.sequence > after && filter(e)).slice(0, limit);
    const last = events.at(-1)?.sequence ?? entry.head.sequence;
    return json({ events, next_after: last < entry.head.sequence ? last : null, sequence: entry.head.sequence });
  }

  async function handleObject(kind, id, operation, request, url) {
    const entry = object(kind, id);
    if (request.method === "GET") {
      if (!entry) return json({ error: "resource not found" }, 404);
      if (operation === "") return json({ ...entry.head, projection_pending: false });
      if (operation === "/history") return historyResponse(entry, url, () => true);
      if (operation === "/facts") return historyResponse(entry, url, (e) => e.type.startsWith("fact."));
      if (operation === "/relationships") return historyResponse(entry, url, (e) => e.type.startsWith("relationship."));
      if (operation === "/decisions") return historyResponse(entry, url, (e) => e.type === "decision.recorded");
      return json({ error: "operation not found" }, 404);
    }
    const key = request.headers.get("idempotency-key");
    if (!key) return json({ error: "Idempotency-Key required" }, 400);
    const body = await request.json();
    const seen = keys.get(`${kind}:${id}:${key}`);
    if (seen) return json(seen, 201);
    if (operation === "") {
      if (entry) return json({ error: "exists" }, 409);
      const event = commit(kind, id, `${kind}.created`, body, body.actor_id);
      keys.set(`${kind}:${id}:${key}`, event);
      return json(event, 201);
    }
    if (!entry) return json({ error: "resource not found" }, 404);
    let type;
    if (kind === "entity") {
      if (operation === "/facts") type = "fact.asserted";
      else if (operation === "/relationships") type = "relationship.asserted";
      else if (operation === "/identity") type = "entity.updated";
      else return json({ error: "operation not found" }, 404);
      if ((type === "fact.asserted" || type === "relationship.asserted") && entry.events.some((e) => e.type === type && e.data.id === body.id)) return json({ error: "exists" }, 409);
    } else {
      if (operation === "/events") type = "session.event";
      else if (operation === "/context") type = "session.context";
      else if (operation === "/decisions") type = "decision.recorded";
      else if (/^\/decisions\/[^/]+\/outcomes$/.test(operation)) { type = "decision.outcome"; body.id = operation.split("/")[2]; }
      else return json({ error: "operation not found" }, 404);
    }
    const event = commit(kind, id, type, body, body.actor_id);
    keys.set(`${kind}:${id}:${key}`, event);
    return json(event, 201);
  }

  async function fetch(input, init = {}) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname });
    if (request.headers.get("authorization") !== "Bearer test-key") return json({ error: "unauthorized" }, 401);

    const os = /^\/v1\/os\/tenants\/([^/]+)\/(entities|sessions)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (os) {
      const [, t, collection, resource, operation = ""] = os;
      if (t !== tenant) return json({ error: "unknown tenant" }, 404);
      const kind = collection === "entities" ? "entity" : "session";
      const id = kind === "entity" && resource === "me" ? actor : resource;
      if (!id.startsWith(prefix)) return json({ error: "resource belongs to another user" }, 403);
      if (kind === "entity" && resource === "me" && operation === "" && request.method === "GET") {
        if (!object("entity", actor)) commit("entity", actor, "entity.created", { type: "user", name: "Test User", actor_id: actor }, actor);
        return json({ ...object("entity", actor).head, projection_pending: false });
      }
      if (request.method === "GET") return handleObject(kind, id, operation, request, url);
      const raw = await request.text();
      const body = JSON.parse(raw);
      body.actor_id = actor;
      if (kind === "session" && operation === "") body.participants = [actor];
      return handleObject(kind, id, operation, new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) }), url);
    }

    const pub = /^\/tenants\/([^/]+)\/(entity|session)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (pub) {
      const [, t, kind, id, operation = ""] = pub;
      if (t !== tenant) return json({ error: "unknown tenant" }, 404);
      return handleObject(kind, id, operation, request, url);
    }

    if (url.pathname === `/tenants/${tenant}/query/` && request.method === "POST") {
      const body = await request.json();
      return json(sqlHandler(body));
    }
    if (url.pathname === `/v1/deployments/${tenant}/endpoints`) {
      return json({ query_endpoint: `https://api.test/tenants/${tenant}/query`, mcp_endpoint: "https://api.test/mcp" });
    }
    return json({ error: `unhandled ${request.method} ${url.pathname}` }, 404);
  }

  return {
    fetch,
    requests,
    objects,
    actor,
    prefix,
    tenant,
    events(kind, id) { return object(kind, id)?.events ?? []; },
    setSql(handler) { sqlHandler = handler; },
    ids(kind) { return [...objects.keys()].filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1)); },
  };
}
