const fs = require('fs')
const path = require('path')

const root = process.cwd()
const targets = [
    'dist',
    'dist-electron',
    'tsconfig.tsbuildinfo',
    'tsconfig.node.tsbuildinfo',
]

for (const target of targets) {
    const absoluteTarget = path.join(root, target)
    try {
        fs.rmSync(absoluteTarget, { recursive: true, force: true })
        process.stdout.write(`[clean:artifacts] removed ${target}\n`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[clean:artifacts] failed ${target}: ${message}\n`)
        process.exitCode = 1
    }
}
