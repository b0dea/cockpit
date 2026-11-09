---
"@b00dea/cockpit": patch
---

The guard no longer holds every agent after a reboot. macOS gives the APFS Data volume a new device number on each boot, and the guard bound the cockpit checkout to its device and inode, so after a restart it reported "the cockpit checkout was moved or replaced" until a person ran `sync`. The checkout is now identified by its canonical path and inode, which still tell a replaced or moved checkout apart, and the Node fingerprint that spares the guard re-hashing Node on each call no longer includes the device number either. Run `sync` once after upgrading: the local guard identity changes format.
