import { useEffect, useRef } from 'react'

// Ordered-dither field in the style of the Lume landing page: a slowly drifting noise image is
// thresholded against a 4x4 Bayer matrix and drawn as paper-coloured squares on ink, with a sparse
// scatter of terracotta cells. The pointer brightens the field around it. Under
// prefers-reduced-motion a single still frame is drawn.

const CELL = 7
const DOT = 5
const INK = '#232323'
const PAPER = '#f5f5f5'
const BRAND = '#e08a6b'
const FPS = 24

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)

/** Deterministic hash in [0, 1) for integer lattice points. */
function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise on an integer lattice. */
function noise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi)
  const b = hash(xi + 1, yi)
  const c = hash(xi, yi + 1)
  const d = hash(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

function field(x: number, y: number, t: number): number {
  const n1 = noise(x * 0.045 + t * 0.35, y * 0.045 - t * 0.2)
  const n2 = noise(x * 0.11 - t * 0.5, y * 0.11 + t * 0.3)
  const n3 = noise(x * 0.26 + 40, y * 0.26 - t * 0.9)
  return n1 * 0.62 + n2 * 0.28 + n3 * 0.1
}

/** Animated dither texture that fills its parent. Purely decorative. */
export default function DitherField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const pointer = { x: -1e4, y: -1e4, strength: 0 }
    let cols = 0
    let rows = 0
    let frame = 0
    let last = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      cols = Math.ceil(rect.width / CELL)
      rows = Math.ceil(rect.height / CELL)
    }

    const draw = (time: number) => {
      const t = time / 4000
      ctx.fillStyle = INK
      ctx.fillRect(0, 0, cols * CELL, rows * CELL)
      const radius = 22
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          let v = field(x, y, t)
          // Carve slow-moving dark islands so the texture has large quiet shapes, like the landing.
          v = (v - 0.34) * 1.9
          if (pointer.strength > 0) {
            const dx = x - pointer.x
            const dy = y - pointer.y
            const d2 = (dx * dx + dy * dy) / (radius * radius)
            if (d2 < 1) v += (1 - d2) * 0.55 * pointer.strength
          }
          const threshold = BAYER[(y & 3) * 4 + (x & 3)]
          if (v <= threshold) continue
          // Terracotta specks live in the mid-tones and change slowly over time.
          const speck = v < 0.9 && hash(x, y + Math.floor(t * 3)) > 0.965
          ctx.fillStyle = speck ? BRAND : PAPER
          ctx.fillRect(x * CELL, y * CELL, DOT, DOT)
        }
      }
    }

    const loop = (time: number) => {
      frame = requestAnimationFrame(loop)
      if (time - last < 1000 / FPS) return
      last = time
      pointer.strength = Math.max(0, pointer.strength - 0.02)
      draw(time)
    }

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      pointer.x = (e.clientX - rect.left) / CELL
      pointer.y = (e.clientY - rect.top) / CELL
      pointer.strength = 1
    }

    resize()
    const observer = new ResizeObserver(() => {
      resize()
      if (reduceMotion) draw(0)
    })
    observer.observe(canvas)

    if (reduceMotion) {
      draw(0)
    } else {
      frame = requestAnimationFrame(loop)
      canvas.parentElement?.addEventListener('pointermove', onPointerMove)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      canvas.parentElement?.removeEventListener('pointermove', onPointerMove)
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden="true" className={`block h-full w-full ${className ?? ''}`} />
}
