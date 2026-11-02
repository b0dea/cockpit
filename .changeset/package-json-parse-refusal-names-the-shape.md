---
"@b0dea/cockpit": patch
---

When `package.json` is not valid JSON, `TEAM_METADATA_UNAVAILABLE` now says where parsing stopped and what shape was expected, the same way the work commands and the browser project check do: `package.json is not valid JSON at line 3, column 1; expected an npm package.json object`. It never quotes the file's contents.
