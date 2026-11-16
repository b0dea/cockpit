---
"@b00dea/cockpit": patch
---

Simplify the stack runtime's internals. Doctor and preflight now report a port collision with many foreign listeners as a failed port row, naming as many listeners as fit, instead of losing every runtime check.
