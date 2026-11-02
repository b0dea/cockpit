---
"@b0dea/cockpit": patch
---

The troubleshooting index and the CLI reference now repeat a fix for a diagnostic code only when every place that raises the code gives that same fix.

- A code raised with different fixes in different situations, such as `DOCUMENT_GAP`, now reads "depends on what failed; see the message" instead of listing one or all of the fixes as if each always applied.
- Codes named through the environment code registry now show their fix too, so `SETUP_CLONE_FAILED` and `RUNTIME_IMAGE_UNAVAILABLE` no longer read "see the message".
- The CLI reference now says that each command's diagnostic list errs towards too many codes, including codes only a related command raises when the two share parts.
