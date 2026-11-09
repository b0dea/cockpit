---
"@b00dea/cockpit": patch
---

A guard call that has not decided within 25 seconds of starting now refuses itself, exiting 2 with a reason saying the guard ran out of time, instead of running into the agent tool's 30-second hook timeout, whose effect is not measured for every tool. It ends the processes it had started, such as Git, before it exits. Retry the call; a heavily loaded machine slows the guard.
