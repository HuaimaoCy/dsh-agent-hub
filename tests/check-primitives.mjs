/**
 * One-off check: every primitive the plugin's browser half destructures must
 * actually be exported by the shell's primitives bundle. A missing name here is
 * a white-screen bug at runtime ("Element type is invalid"), and it is invisible
 * to every other test in this directory because the failure happens in the
 * browser, not in Node.
 *
 * It needs the DSH source checkout, so it is deliberately NOT part of `npm test`:
 *
 *   node tests/check-primitives.mjs client.js \
 *     <checkout>/packages/client/ui-primitives/lib/index.js
 *
 * `lib/index.js` is the artifact the shell actually hands to the browser module
 * table, which makes checking against it stronger than reading the sources.
 */
import { readFileSync } from 'node:fs'

const [clientPath, bundlePath] = process.argv.slice(2)
const client = readFileSync(clientPath, 'utf8')
const bundle = readFileSync(bundlePath, 'utf8')

// The destructuring block that binds the primitives module. The plugin may bind
// the module to a local first and destructure from that, so both shapes are
// accepted.
const direct = /const\s*\{([\s\S]*?)\}\s*=\s*require\('@deepseek-ai\/dsh-client-ui-primitives'\)/.exec(client)
const viaLocal = /const\s+([A-Za-z0-9_$]+)\s*=\s*require\('@deepseek-ai\/dsh-client-ui-primitives'\)[\s\S]*?const\s*\{([\s\S]*?)\}\s*=\s*\1\b/.exec(client)
const requireMatch = direct ?? viaLocal
if (requireMatch === null) {
  console.error('FAIL: could not find the primitives destructuring block in client.js')
  process.exit(1)
}
const wanted = (direct === null ? requireMatch[2] : requireMatch[1])
  .split(/[,\n]/)
  .map(part => part.trim())
  .filter(part => part !== '' && !part.startsWith('//'))

// Every name the bundle exports, from `export { … }` blocks and direct exports.
const exported = new Set()
for (const block of bundle.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
  for (const entry of block[1].split(',')) {
    const name = entry.trim().split(/\s+as\s+/).pop()?.trim()
    if (name !== undefined && name !== '') exported.add(name)
  }
}
for (const match of bundle.matchAll(/export\s+(?:const|function|class|let|var)\s+([A-Za-z0-9_$]+)/g)) {
  exported.add(match[1])
}

console.log(`client destructures ${wanted.length} names; bundle exports ${exported.size}`)
const missing = wanted.filter(name => !exported.has(name))
if (missing.length > 0) {
  console.log(`\nMISSING (${missing.length}):`)
  for (const name of missing) console.log(`  - ${name}`)
  process.exit(1)
}
console.log('\nall primitive names resolve')
