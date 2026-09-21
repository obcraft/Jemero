#!/usr/bin/env node
// Stops the built-in model server. `npm start` leaves it running on purpose so
// the next launch doesn't reload the weights; this is the off switch.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { stopServing } = require('../electron/model.cjs')

const stopped = stopServing()
console.log(stopped ? '\x1b[35m◆\x1b[0m model server stopped' : '\x1b[90m◆ no model server was running\x1b[0m')
