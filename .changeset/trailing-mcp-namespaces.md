---
"@b00dea/cockpit": patch
---

Refuse a restricted MCP server whose native namespace overlaps another server's through a trailing underscore. `mcp__foo___read` falls in `foo`'s prefix, so restricting `foo` beside `foo_` denied `foo_`'s tools as `foo`'s.
