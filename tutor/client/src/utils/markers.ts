export function extractSceneNames(text: string): string[] {
  const names: string[] = []
  let idx = 0
  while (true) {
    const start = text.indexOf('[SHOW_SCENE ', idx)
    if (start < 0) break
    const end = text.indexOf(']', start)
    if (end < 0) break
    names.push(text.slice(start + '[SHOW_SCENE '.length, end))
    idx = end + 1
  }
  return names
}

export function extractSpotlights(text: string): { sceneName: string; elementId: string }[] {
  const items: { sceneName: string; elementId: string }[] = []
  let idx = 0
  while (true) {
    const start = text.indexOf('[SPOTLIGHT ', idx)
    if (start < 0) break
    const end = text.indexOf(']', start)
    if (end < 0) break
    const payload = text.slice(start + '[SPOTLIGHT '.length, end)
    const parts = payload.split(' ')
    if (parts.length >= 2) items.push({ sceneName: parts[0], elementId: parts[1] })
    idx = end + 1
  }
  return items
}

export function extractClicks(text: string): { sceneName: string; elementId: string }[] {
  const items: { sceneName: string; elementId: string }[] = []
  let idx = 0
  while (true) {
    const start = text.indexOf('[CLICK ', idx)
    if (start < 0) break
    const end = text.indexOf(']', start)
    if (end < 0) break
    const payload = text.slice(start + '[CLICK '.length, end)
    const parts = payload.split(' ')
    if (parts.length >= 2) items.push({ sceneName: parts[0], elementId: parts[1] })
    idx = end + 1
  }
  return items
}

export function extractKeypoints(text: string): string[] {
  const kps: string[] = []
  const re = /\[KEYPOINT\]([\s\S]*?)\[\/KEYPOINT\]/g
  let m
  while ((m = re.exec(text)) !== null) {
    const kp = m[1].trim()
    if (kp) kps.push(kp)
  }
  return kps
}

export function stripMarkers(text: string): string {
  let t = text
  // [KEYPOINT]...[/KEYPOINT]
  while (true) {
    const s = t.indexOf('[KEYPOINT]')
    const e = t.indexOf('[/KEYPOINT]')
    if (s < 0 || e < 0 || e < s) break
    t = t.slice(0, s) + t.slice(e + '[/KEYPOINT]'.length)
  }
  // [SPEECH]/[/SPEECH]
  t = t.split('[SPEECH]').join('').split('[/SPEECH]').join('')
  // [SHOW_SCENE ...]
  while (true) {
    const s = t.indexOf('[SHOW_SCENE ')
    if (s < 0) break
    const e = t.indexOf(']', s)
    if (e < 0) { t = t.slice(0, s); break }
    t = t.slice(0, s) + t.slice(e + 1)
  }
  // [SPOTLIGHT ...]
  while (true) {
    const s = t.indexOf('[SPOTLIGHT ')
    if (s < 0) break
    const e = t.indexOf(']', s)
    if (e < 0) { t = t.slice(0, s); break }
    t = t.slice(0, s) + t.slice(e + 1)
  }
  // [CLICK ...]
  while (true) {
    const s = t.indexOf('[CLICK ')
    if (s < 0) break
    const e = t.indexOf(']', s)
    if (e < 0) { t = t.slice(0, s); break }
    t = t.slice(0, s) + t.slice(e + 1)
  }
  // [LASER:...]
  while (true) {
    const s = t.indexOf('[LASER:')
    if (s < 0) break
    const e = t.indexOf(']', s)
    if (e < 0) { t = t.slice(0, s); break }
    t = t.slice(0, s) + t.slice(e + 1)
  }
  return t
}
