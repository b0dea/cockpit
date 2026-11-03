---
"@b00dea/cockpit": patch
---

`work grade` judges the grader's evidence by its quote rather than by exact character offsets. A real model often miscounts offsets, which made every criterion read as "evidence is insufficient" even when the quoted text was right. A quote must still appear verbatim in the cited file or command output; when the cited range does not hold it, cockpit uses the occurrence nearest that range.
