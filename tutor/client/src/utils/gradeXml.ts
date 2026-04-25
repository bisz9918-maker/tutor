import { cleanLatex, escapeHtml, replaceNewlinesOutsideMath } from './latex'

interface GradeResult {
  result_code: number
  error_type: string
  one_sentence_judgement: string
  error_analysis: string[]
  improvement_suggestions: string[]
  recommended_exercise: string
  recommendation_reason: string
}

function parseGradeXML(raw: string): GradeResult | null {
  const xmlMatch = raw.match(/<result>([\s\S]*?)<\/result>/)
  if (!xmlMatch) return null

  const xml = xmlMatch[1]
  const getText = (tag: string): string => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].trim() : ''
  }
  const getList = (tag: string): string[] => {
    const items: string[] = []
    const re = new RegExp(`<item>([\\s\\S]*?)</item>`, 'g')
    const section = getText(tag)
    let m
    while ((m = re.exec(section)) !== null) {
      items.push(m[1].trim())
    }
    return items
  }

  return {
    result_code: parseInt(getText('result_code')) || 0,
    error_type: getText('error_type'),
    one_sentence_judgement: getText('one_sentence_judgement'),
    error_analysis: getList('error_analysis'),
    improvement_suggestions: getList('improvement_suggestions'),
    recommended_exercise: getText('recommended_exercise'),
    recommendation_reason: getText('recommendation_reason'),
  }
}

function renderInline(text: string): string {
  return replaceNewlinesOutsideMath(cleanLatex(escapeHtml(text)))
}

export function renderGradeXML(raw: string): string {
  const result = parseGradeXML(raw)
  if (!result) {
    // Fallback: strip XML tags and render as text
    const stripped = raw.replace(/<[^>]+>/g, '').trim()
    return `<div class="grade-result-fallback">${renderInline(stripped)}</div>`
  }

  const isCorrect = result.result_code === 100

  let html = '<div class="grade-result-card">'

  // Header: verdict
  html += `<div class="grade-verdict ${isCorrect ? 'correct' : 'wrong'}">`
  html += `<span class="grade-verdict-icon">${isCorrect ? '✓' : '✗'}</span>`
  html += `<span>${renderInline(result.one_sentence_judgement)}</span>`
  if (result.error_type) {
    html += `<span class="grade-error-type">${renderInline(result.error_type)}</span>`
  }
  html += '</div>'

  // Error analysis
  if (result.error_analysis.length > 0) {
    html += '<div class="grade-section"><div class="grade-section-title">错误分析</div>'
    for (const item of result.error_analysis) {
      html += `<div class="grade-item">${renderInline(item)}</div>`
    }
    html += '</div>'
  }

  // Improvement suggestions
  if (result.improvement_suggestions.length > 0) {
    html += '<div class="grade-section"><div class="grade-section-title">改进建议</div>'
    for (const item of result.improvement_suggestions) {
      html += `<div class="grade-item grade-suggestion">${renderInline(item)}</div>`
    }
    html += '</div>'
  }

  // Recommended exercise
  if (result.recommended_exercise) {
    html += '<div class="grade-section"><div class="grade-section-title">推荐练习</div>'
    html += `<div class="grade-item grade-exercise">${renderInline(result.recommended_exercise)}</div>`
    if (result.recommendation_reason) {
      html += `<div class="grade-reason">${renderInline(result.recommendation_reason)}</div>`
    }
    html += '</div>'
  }

  html += '</div>'
  return html
}
