import { ref, onUnmounted } from 'vue'
import { useGuideStore } from '../stores/guide'
import { extractSpotlights, extractClicks } from '../utils/markers'

// ── Module-level spotlight state (shared across all useScene instances) ──────
let spotlightOriginals: any[] = []
let spotlightTimer: ReturnType<typeof setTimeout> | null = null

function applyClicks(iframe: HTMLIFrameElement, items: { sceneName: string; elementId: string }[]) {
  const doc = iframe.contentDocument
  if (!doc) return
  for (const item of items) {
    const el = doc.getElementById(item.elementId)
    if (el) el.click()
  }
}

function applySpotlights(iframe: HTMLIFrameElement, items: { sceneName: string; elementId: string }[]) {
  clearSpotlight()
  const doc = iframe.contentDocument
  if (!doc) return
  for (const item of items) {
    const el = doc.getElementById(item.elementId)
    if (!el) continue
    const tag = el.tagName.toLowerCase()
    const orig: any = {
      el,
      stroke: el.getAttribute('stroke'),
      fill: el.getAttribute('fill'),
      strokeWidth: el.getAttribute('stroke-width'),
      opacity: el.getAttribute('opacity'),
      styleOpacity: (el as HTMLElement).style.opacity,
      fillOpacity: el.getAttribute('fill-opacity'),
      filter: (el as HTMLElement).style.filter,
      transition: (el as HTMLElement).style.transition,
      outline: (el as HTMLElement).style.outline,
      boxShadow: (el as HTMLElement).style.boxShadow,
    }
    spotlightOriginals.push(orig)
    const isShape = (tag === 'polygon' || tag === 'path' || tag === 'ellipse' || tag === 'rect')
    const isLine = (tag === 'line' || tag === 'polyline')
    const isHtmlEl = (tag === 'button' || tag === 'a' || tag === 'div' || tag === 'span')
    const highlightColor = '#ff6d00'
    if (isHtmlEl) {
      ;(el as HTMLElement).style.outline = '3px solid ' + highlightColor
      ;(el as HTMLElement).style.boxShadow = '0 0 8px ' + highlightColor
      ;(el as HTMLElement).style.transition = 'all 0.3s ease'
      continue
    }
    const curOpacity = parseFloat((el as HTMLElement).style.opacity)
    const attrOpacity = parseFloat(el.getAttribute('opacity') || '')
    if (isNaN(curOpacity) && isNaN(attrOpacity) || attrOpacity === 0) {
      ;(el as HTMLElement).style.opacity = '1'
    }
    if (isShape && el.getAttribute('fill') && el.getAttribute('fill') !== 'none') {
      el.setAttribute('fill', highlightColor)
      el.setAttribute('fill-opacity', '0.35')
    }
    if (el.getAttribute('stroke') && el.getAttribute('stroke') !== 'none') {
      el.setAttribute('stroke', highlightColor)
      const sw = parseFloat(el.getAttribute('stroke-width') || '1.5')
      el.setAttribute('stroke-width', String(sw * 2))
    }
    if (isLine && (orig.fill === 'none' || !orig.fill)) el.setAttribute('fill', 'none')
    ;(el as HTMLElement).style.filter = 'drop-shadow(0 0 4px ' + highlightColor + ')'
    ;(el as HTMLElement).style.transition = 'all 0.3s ease'
  }
  spotlightTimer = setTimeout(clearSpotlight, 5000)
}

function clearSpotlight() {
  if (spotlightTimer) { clearTimeout(spotlightTimer); spotlightTimer = null }
  for (const o of spotlightOriginals) {
    const el = o.el
    if (o.stroke !== null) el.setAttribute('stroke', o.stroke); else el.removeAttribute('stroke')
    if (o.fill !== null) el.setAttribute('fill', o.fill); else el.removeAttribute('fill')
    if (o.strokeWidth !== null) el.setAttribute('stroke-width', o.strokeWidth); else el.removeAttribute('stroke-width')
    if (o.opacity !== null) el.setAttribute('opacity', o.opacity); else el.removeAttribute('opacity')
    el.style.opacity = o.styleOpacity || ''
    if (o.fillOpacity !== null) el.setAttribute('fill-opacity', o.fillOpacity); else el.removeAttribute('fill-opacity')
    el.style.filter = o.filter || ''
    el.style.transition = o.transition || ''
    el.style.outline = o.outline || ''
    el.style.boxShadow = o.boxShadow || ''
  }
  spotlightOriginals = []
}

/** Execute CLICK and SPOTLIGHT markers on the scene iframe. */
export function applyMarkers(text: string) {
  const clicks = extractClicks(text)
  const spotlights = extractSpotlights(text)
  if (!clicks.length && !spotlights.length) return

  const tryApply = (iframe: HTMLIFrameElement) => {
    if (!iframe.contentDocument) return false
    if (clicks.length) applyClicks(iframe, clicks)
    if (spotlights.length) applySpotlights(iframe, spotlights)
    return true
  }

  const iframe = document.getElementById('guide-scene-iframe') as HTMLIFrameElement | null
  if (iframe && tryApply(iframe)) return

  // Iframe not ready (e.g. just switched scenes), retry after a short delay
  setTimeout(() => {
    const iframe2 = document.getElementById('guide-scene-iframe') as HTMLIFrameElement | null
    if (iframe2) tryApply(iframe2)
  }, 500)
}

export function useScene() {
  const guideStore = useGuideStore()
  const currentSceneUrl = ref('')
  const currentSceneIsHtml = ref(false)
  const sceneScaleHandler = ref<(() => void) | null>(null)

  function showScene(name: string) {
    const sc = guideStore.currentScenes.find(x => x.name === name)
    if (!sc) return
    guideStore.showScene(name)
    currentSceneUrl.value = sc.url
    currentSceneIsHtml.value = sc.isHtml
  }

  function scaleIframe(iframe: HTMLIFrameElement, wrap: HTMLElement) {
    const w = wrap.clientWidth || wrap.offsetWidth
    if (!w) { requestAnimationFrame(() => scaleIframe(iframe, wrap)); return }
    // Available height: from wrap top to bottom of .guide-scene container
    const sceneEl = wrap.closest('.guide-scene') as HTMLElement | null
    const availableH = sceneEl ? sceneEl.clientHeight - wrap.offsetTop - 20 : 0
    try {
      const doc = iframe.contentDocument
      if (doc?.body) {
        doc.body.style.margin = '0'
        doc.body.style.padding = '0'
        doc.body.style.minHeight = '0'
        doc.body.style.display = 'block'
      }
      iframe.style.zoom = '1'
      const firstEl = doc?.body?.firstElementChild as HTMLElement | null
      const contentW = firstEl ? (firstEl.scrollWidth || firstEl.offsetWidth) : (doc?.body?.scrollWidth || 800)
      const contentH = Math.max(
        firstEl ? (firstEl.scrollHeight || firstEl.offsetHeight) : 0,
        doc?.body?.scrollHeight || 0,
        200,
      ) + 20
      const scaleW = w / contentW
      const scaleH = availableH > 0 ? availableH / contentH : scaleW
      const scale = Math.min(scaleW, scaleH)
      iframe.style.zoom = String(scale)
      iframe.style.width = contentW + 'px'
      iframe.style.height = contentH + 'px'
      iframe.style.transform = ''
      wrap.style.height = (contentH * scale) + 'px'
    } catch {
      const scaleW = w / 800
      const scaleH = availableH > 0 ? availableH / 800 : scaleW
      const scale = Math.min(scaleW, scaleH)
      iframe.style.zoom = String(scale)
      iframe.style.width = '800px'
      iframe.style.height = '800px'
      iframe.style.transform = ''
      wrap.style.height = (800 * scale) + 'px'
    }
  }

  function onIframeLoad(iframe: HTMLIFrameElement, wrap: HTMLElement) {
    const scale = () => scaleIframe(iframe, wrap)
    requestAnimationFrame(() => {
      scale()
      requestAnimationFrame(scale)
    })
    setTimeout(scale, 300)
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth || wrap.offsetWidth
      if (w > 0) scale()
    })
    ro.observe(wrap)

    if (sceneScaleHandler.value) {
      window.removeEventListener('resize', sceneScaleHandler.value)
    }
    sceneScaleHandler.value = scale
    window.addEventListener('resize', scale)
  }

  onUnmounted(() => {
    if (sceneScaleHandler.value) {
      window.removeEventListener('resize', sceneScaleHandler.value)
    }
    clearSpotlight()
  })

  return {
    currentSceneUrl, currentSceneIsHtml,
    showScene, onIframeLoad, clearSpotlight,
  }
}
