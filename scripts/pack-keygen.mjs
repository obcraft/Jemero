#!/usr/bin/env node
// Makes the Ed25519 key packs are signed with (scripts/packs.mjs).
//
//   npm run packs:keygen
//
// The private key goes to .keys/pack-signing.pem (gitignored: keep it safe, and
// give it to CI as JEMERO_PACK_SIGNING_KEY). The public key is added to
// electron/pack-trust.json, which ships in the app and decides which packs it
// accepts. Refuses to replace an existing private key.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { generateKeys } = require('../electron/pack-sign.cjs')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const KEY_FILE = path.join(ROOT, '.keys', 'pack-signing.pem')
const TRUST_FILE = path.join(ROOT, 'electron', 'pack-trust.json')

if (fs.existsSync(KEY_FILE)) {
  console.error(`pack-keygen: ${path.relative(ROOT, KEY_FILE)} already exists; not replacing it.`)
  process.exit(1)
}

const { privateKeyPem, publicKeyDer, keyId } = generateKeys()
fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 })
fs.writeFileSync(KEY_FILE, privateKeyPem, { mode: 0o600 })

const trust = fs.existsSync(TRUST_FILE) ? JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8')) : { keys: {} }
trust.keys = { ...trust.keys, [keyId]: publicKeyDer }
fs.writeFileSync(TRUST_FILE, JSON.stringify(trust, null, 2) + '\n')

console.log(`pack-keygen: key ${keyId}`)
console.log(`  private: ${path.relative(ROOT, KEY_FILE)} (never commit; CI reads it from JEMERO_PACK_SIGNING_KEY)`)
console.log(`  public:  added to ${path.relative(ROOT, TRUST_FILE)} (commit this)`)
