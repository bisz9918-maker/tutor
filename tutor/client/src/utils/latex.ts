const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}

export function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, c => HTML_ENTITIES[c] || c)
}

export function cleanLatex(t: string): string {
  return t
    .replace(/\\begin\{(align|aligned|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|gather|gathered|equation|split|array|tabular)\}[\s\S]*?\\end\{\1\}/g, m => m.replace(/&/g, ' '))
    .replace(/\\begin\{(itemize|enumerate|description)\}[\s\S]*?\\end\{\1\}/g, '')
    .replace(/\\begin\{(\w+)\}[\s\S]*?\\end\{\1\}/g, m => m)
}

export function replaceNewlinesOutsideMath(text: string): string {
  const parts: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '$') {
      const end = text.indexOf('$$', i + 2)
      if (end >= 0) {
        parts.push(text.slice(i, end + 2))
        i = end + 2
        continue
      }
    }
    if (text[i] === '$') {
      const end = text.indexOf('$', i + 1)
      if (end >= 0) {
        parts.push(text.slice(i, end + 1))
        i = end + 1
        continue
      }
    }
    if (text[i] === '\n') {
      parts.push('<br>')
      i++
      continue
    }
    let j = i
    while (j < text.length && text[j] !== '$' && text[j] !== '\n') j++
    parts.push(text.slice(i, j))
    i = j
  }
  return parts.join('')
}
