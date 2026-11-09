---
"@b00dea/cockpit": patch
---

The guard no longer holds a call because one of its words is longer than a file name may be. A commit message, search pattern or `echo` argument of 256 or more bytes without a slash made the guard's existence probe fail with `ENAMETOOLONG`, and the call was held as "Guard authority could not be read or revalidated", which read like a damaged installation. Such a word now names nothing, as a missing path does. A path the call names that the guard cannot inspect for another reason, such as a permission error, now holds the call with a message naming that path instead of the guard's authority.
