---
"@b00dea/cockpit": patch
---

`cockpit upgrade` now quotes the lines that explain a failed install, such as the package manager's 404 or the registry error, from both its output streams, instead of a runtime deprecation warning. When a package-age filter refused a release that is too new, the message says so and offers to wait or to exempt the package in your own package-manager settings.
