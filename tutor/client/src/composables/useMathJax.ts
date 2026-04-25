import { nextTick } from 'vue'

export function useMathJax() {
  async function waitForMathJax(): Promise<any> {
    const MJ = (window as any).MathJax
    if (MJ?.typesetPromise) return MJ
    return new Promise((resolve) => {
      const check = () => {
        const m = (window as any).MathJax
        if (m?.typesetPromise) { resolve(m); return }
        setTimeout(check, 200)
      }
      check()
    })
  }

  async function typeset(el: HTMLElement | null) {
    if (!el) return
    try {
      const MJ = await waitForMathJax()
      if (MJ.typesetClear) MJ.typesetClear([el])
      await MJ.typesetPromise([el])
    } catch (e) {
      console.warn('[MathJax] typeset error:', e)
    }
  }

  function typesetAsync() {
    nextTick(async () => {
      try {
        const MJ = await waitForMathJax()
        await MJ.typesetPromise()
      } catch (e) {
        console.warn('[MathJax] typesetAsync error:', e)
      }
    })
  }

  return { typeset, typesetAsync }
}
