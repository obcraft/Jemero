// Signed manifests for packs and the pack index.
//
// Everything the pack store downloads is trusted only through a signature: the
// index and each pack's manifest are Ed25519-signed at build time (scripts/
// packs.mjs, on a developer's machine or in CI), and the app checks them
// against the public keys in pack-trust.json. File hashes then come from the
// signed manifest, so a tampered file, index or manifest is refused.
//
// The envelope keeps the payload as the exact string that was signed, so no
// JSON re-serialisation can change what the signature covers.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const FORMAT = 'jemero-signed/1'

/** Short, stable id of a public key: the first 16 hex digits of its SPKI hash. */
function keyIdOf(publicKey) {
  const key = publicKey instanceof crypto.KeyObject && publicKey.type === 'public' ? publicKey : crypto.createPublicKey(publicKey)
  const der = key.export({ type: 'spki', format: 'der' })
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)
}

/** Sign a JSON-able value with an Ed25519 private key (PEM or KeyObject). */
function sign(value, privateKey) {
  const key = crypto.createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Pack signing needs an Ed25519 key')
  const payload = JSON.stringify(value, null, 2)
  const signature = crypto.sign(null, Buffer.from(payload), key).toString('base64')
  return { format: FORMAT, keyId: keyIdOf(crypto.createPublicKey(key)), payload, signature }
}

/** The trusted public keys: { keyId: base64 SPKI DER }. */
function loadTrust(file = path.join(__dirname, 'pack-trust.json')) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).keys ?? {}
  } catch {
    return {}
  }
}

/**
 * Check an envelope and return its payload. Throws with a message fit for the
 * UI when the signature is missing, from an unknown key, or doesn't match.
 */
function verify(envelope, trust = loadTrust()) {
  if (!envelope || envelope.format !== FORMAT || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    throw new Error('The manifest is not signed')
  }
  const spki = trust[envelope.keyId]
  if (!spki) throw new Error(`The manifest is signed with an unknown key (${envelope.keyId})`)
  const key = crypto.createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' })
  const ok = crypto.verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64'))
  if (!ok) throw new Error('The manifest signature does not match; it may have been tampered with')
  return JSON.parse(envelope.payload)
}

/** A fresh Ed25519 key pair, for scripts/pack-keygen.mjs and tests. */
function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyDer: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    keyId: keyIdOf(publicKey),
  }
}

module.exports = { FORMAT, sign, verify, loadTrust, keyIdOf, generateKeys }
