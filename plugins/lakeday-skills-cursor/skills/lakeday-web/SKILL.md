---
name: lakeday-web
description: Use Lakeday's sandboxed web_search and browser_tool to gather external evidence (release notes, incident reports, docs) and cite it as url references in knowledge records.
license: MIT
---

## Web research through Lakeday

### Source Of Truth

- Docs: https://docs.lakeday.ai/docs/built-ins/search.
- `web_search` uses the tenant's Keenable key (Workspace settings → General → Search);
  `browser_tool` drives a persistent named Obscura session. Credentials stay in the host.

### Default Posture

- Search before browsing; browse only to read a specific page.
- One named browser session per task (`session="incident-042"`); close it with `browser_close`.
- Read pages as markdown or snapshots, not screenshots, unless layout matters.
- Cite what you used: every external page that informed a decision becomes an evidence reference
  `{ "kind": "url", "id": "<url>" }` and, for durable facts, an `entity_fact` with the URL as evidence.
- Never paste credentials into the browser; log in only through flows the user asked for.

### Workflow

1. `web_search(tenant_id, query, site?, max_results?)` → shortlist URLs.
2. `browser_tool(tenant_id, session, tool="browser_navigate", arguments={url})`.
3. `browser_tool(..., tool="browser_markdown")` or `browser_snapshot` to read; `browser_extract`
   or `browser_search` for targeted text.
4. Record: facts on the subject entity (`release:v42` → `changed: "timeout 1200ms → 200ms"`),
   with the URL as evidence.
5. `browser_close(tenant_id, session)`.

### Browser tools

`browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`, `browser_snapshot`,
`browser_markdown`, `browser_links`, `browser_extract`, `browser_interactive_elements`,
`browser_detect_forms`, `browser_get_attribute`, `browser_count`, `browser_search`, `browser_click`,
`browser_fill`, `browser_fill_form`, `browser_type`, `browser_press_key`, `browser_select_option`,
`browser_scroll`, `browser_wait_for`, `browser_wait_for_text`, `browser_evaluate`,
`browser_network_requests`, `browser_console_messages`, `browser_screenshot`, `browser_pdf`,
`browser_get_cookies`, `browser_set_cookie`, `browser_clear_cookies`, `browser_storage_state`,
`browser_set_storage_state`, `browser_tab_new`, `browser_tab_list`, `browser_tab_switch`,
`browser_tab_close`.

### Related Skills

- `lakeday-record` for turning findings into facts with evidence.
- `lakeday-investigate` where external context (release notes) meets internal data.
