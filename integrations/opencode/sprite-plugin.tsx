/** @jsxImportSource @opentui/solid */
// @ts-nocheck — standalone opencode TUI plugin; peer deps resolve inside opencode's runtime.
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { readFileSync, watch, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createSignal } from "solid-js"
import { GRAPHICS_CAPABILITY, graphicsCapability } from "../../src/render/term/capability.js"
import { imageIdFor } from "../../src/render/term/placeholder.js"
import { pngSize } from "../../src/render/term/box.js"
import { readJson } from "../../src/bus/store.js"
import { loadAnimationRefSync } from "familiar-theme"
import { planAnimation } from "../../src/animation/program.js"
import { encodeKittyProgram } from "../../src/render/term/kitty-animation.js"
import { writeAllSync } from "../../src/render/term/io.js"
import { logError } from "./binding.js"
import { createSpriteRuntime } from "./sprite-runtime.js"

const STATE_DIR = process.env.FAMILIAR_STATE_DIR ?? join(homedir(), ".local", "state", "familiar")
const INTENT = join(STATE_DIR, "intent.json")
const PLACEMENT_ID = 1
const MAX_ROWS = 16

const tui: TuiPlugin = async (api) => {
  const capability = graphicsCapability(process.env)
  if (capability === GRAPHICS_CAPABILITY.NONE) return

  const pid = process.pid
  const [boxRows, setBoxRows] = createSignal(0)
  const runtime = createSpriteRuntime({
    pid,
    stateDir: STATE_DIR,
    intentPath: INTENT,
    imageId: imageIdFor(`opencode:${pid}`),
    placementId: PLACEMENT_ID,
    maxRows: MAX_ROWS,
    capability,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
    ensureDirectory: (path) => mkdirSync(path, { recursive: true }),
    watchDirectory: (path, onEvent) => watch(path, onEvent),
    readIntent: (path) => readJson(path),
    readPng: (path) => readFileSync(path),
    sizePng: (bytes) => pngSize(bytes),
    loadAnimation: (ref) => loadAnimationRefSync(ref),
    plan: (options) => planAnimation(options),
    encode: (program, options) => encodeKittyProgram(program, options),
    writeTerminal: (output) => writeAllSync(Buffer.from(output)),
    renderer: api.renderer,
    onPoseChange: (rows) => setBoxRows(rows),
    logError,
  })

  api.renderer.addPostProcessFn(runtime.frame)
  api.lifecycle.onDispose(async () => {
    try { await runtime.dispose() }
    finally { api.renderer.removePostProcessFn(runtime.frame) }
  })
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content() {
        function captureBox(this: any) { runtime.captureBox(this) }
        return <box width="100%" height={boxRows()} renderAfter={captureBox} />
      },
    },
  })
  await runtime.start()
}

const plugin: TuiPluginModule & { id: string } = { id: "familiar.sprite", tui }
export default plugin
