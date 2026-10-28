---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Show the document owner's exact attributed inferred and default values in pending init JSON, human output and interactive questions before accepting their confirmation digest. The review draft is not published as configuration, and stale digests remain refused.

Upgrade: inspect `result.question.document` when init asks `configuration.defaults`, then approve the matching `result.question.expectedSha256`.
