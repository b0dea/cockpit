---
"@b00dea/cockpit": patch
---

Recommend Varlock schema adoption during init and doctor when a repository root contains dotenv or environment template files without a `.env.schema`. Discovery inspects file names and types only and remains advisory for both surfaces-only and runtime cockpits.
