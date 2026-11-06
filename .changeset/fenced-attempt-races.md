---
'@b00dea/cockpit': patch
---

Fix races in fenced execution that could run a cancelled action or leave an attempt stuck on "repair required".

- An executor that started late could still run its action after that attempt's cancellation was certified and cleaned up. It now refuses.
- A stop acknowledged before the action was released was dropped, so the action still ran. It now never starts.
- An attempt stayed stuck when its supervisor was killed for losing the marker race, when the executor died after publishing its marker, or when a marker landed although publishing it reported failure. Each of these now repairs normally.
- A second recoverer, or an executor that died late, could leave a marker the state inventory refuses. Neither does now.
