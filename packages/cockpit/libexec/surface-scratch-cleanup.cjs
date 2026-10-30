'use strict'

// Removes the private staging directory that packages/cockpit/src/surfaces/generator-adapter.ts
// created for one surface generation. Runs from a staged snapshot, so it must stay self-contained.
//
// argv: <request JSON { target, parent }>. Refuses (non-zero exit) any target that is not a
// cockpit-surfaces-* directory directly inside the named parent.
const fs = require('node:fs')
const path = require('node:path')

const request = JSON.parse(process.argv[2])
const target = request.target
if (path.dirname(target) !== request.parent || !path.basename(target).startsWith('cockpit-surfaces-')) throw new Error('cleanup target refused')
fs.rmSync(target, { recursive: true, force: true })
