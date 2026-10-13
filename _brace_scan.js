const fs = require('fs')
const src = fs.readFileSync('src/main/automation/TrafficBoostEngine.ts', 'utf8')
const lines = src.split(/\n/)
let i = 0
const stack = []
let line = 1
let col = 1
let mode = 'code'
const opens = new Set(['{', '(', '['])
const closeOf = { '}': '{', ')': '(', ']': '[' }

function interesting(entry) {
  const txt = lines[entry.l - 1].replace(/\r$/, '').trim().slice(0, 140)
  return entry.l + ':' + entry.c + ' ' + entry.k + ' | ' + txt
}

while (i < src.length) {
  const ch = src[i]
  const next = src[i + 1]
  if (mode === 'code') {
    if (ch === '/' && next === '/') mode = 'line'
    else if (ch === '/' && next === '*') { mode = 'block'; i++; col++ }
    else if (ch === '"' || ch === "'" || ch === '`') mode = ch
    else if (opens.has(ch)) stack.push({ k: ch, l: line, c: col })
    else if (closeOf[ch]) {
      const top = stack[stack.length - 1]
      if (!top || top.k !== closeOf[ch]) {
        console.log('MISMATCH', ch, 'at', line + ':' + col, 'top', top && interesting(top))
        break
      }
      stack.pop()
    }
  } else if (mode === 'line') {
    if (ch === '\n') mode = 'code'
  } else if (mode === 'block') {
    if (ch === '*' && next === '/') { mode = 'code'; i++; col++ }
  } else if (mode === '"' || mode === "'") {
    if (ch === '\\') { i++; col++ }
    else if (ch === mode) mode = 'code'
  } else if (mode === '`') {
    if (ch === '\\') { i++; col++ }
    else if (ch === mode) mode = 'code'
    else if (ch === '$' && next === '{') {
      mode = 'code'
      stack.push({ k: '${', l: line, c: col })
      i++
      col++
    }
  }
  if (ch === '\n') { line++; col = 1 } else col++
  i++
  if (line === 4690 && col === 1) {
    console.log('OPEN AT 4690 depth', stack.length)
    for (const s of stack.slice(-40)) console.log(interesting(s))
    break
  }
}
