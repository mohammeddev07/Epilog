import { execFileSync } from 'node:child_process'
import { log } from 'node:console'
import { readFileSync } from 'node:fs'

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parts(tag) {
  return tag.slice(1).split('.').map(BigInt)
}

function compareTags(first, second) {
  const right = parts(second)
  for (const [index, component] of parts(first).entries()) {
    if (component !== right[index]) return component > right[index] ? 1 : -1
  }
  return 0
}

function latestTag(...args) {
  return execFileSync('git', ['tag', '--list', 'v*', ...args], { encoding: 'utf8' })
    .split('\n')
    .filter((tag) => stableTag.test(tag))
    .sort(compareTags)
    .at(-1)
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const packageTag = `v${version}`
if (!stableTag.test(packageTag)) {
  throw new Error('package.json must use a stable major.minor.patch version for production releases.')
}

const current = latestTag('--points-at', 'HEAD')
const latest = latestTag()
if (current) {
  log(current)
} else if (!latest || compareTags(packageTag, latest) > 0) {
  log(packageTag)
} else {
  const [major, minor, patch] = parts(latest)
  log(`v${major}.${minor}.${patch + 1n}`)
}
