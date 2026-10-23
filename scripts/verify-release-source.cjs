const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const version = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version
const isTag = process.env.GITHUB_REF_TYPE === 'tag'
const tag = isTag ? process.env.GITHUB_REF_NAME : null
if (isTag && tag !== `v${version}`) {
  console.error(`Release tag ${tag} does not match source version ${version}. Point the tag at the reviewed source before publishing.`)
  process.exitCode = 1
} else {
  console.log(`Release source verified: version=${version}; tag=${tag || 'local/non-tag build'}`)
}
