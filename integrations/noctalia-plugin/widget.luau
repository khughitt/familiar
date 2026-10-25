--!strict
-- Widget entry `workspaces`: one bar's workspace pills for its output. Left click
-- focuses the pill's stable Niri ID; right click dismisses exactly the alerts the pill
-- showed when it was drawn; middle click stays Noctalia's settings gesture. The Alerts
-- button opens the panel, which can dismiss even if right click is bound elsewhere.
-- Attribution is drawn only while both the coordinator and the workspace feed are
-- trusted; navigation keeps working from the service's own Niri fallback otherwise.

local P = require("./presentation.luau")

local navigation: any = noctalia.state.get("familiar/navigation")
local attention: any = noctalia.state.get("familiar/attention")
local output: string? = nil
local vertical = false
local cadence = 0
-- Episodes this widget found when it first saw attention are history: no arrival.
local known: { [string]: boolean }? = nil
local arrivals: { [string]: number } = {}

local function withAlpha(color: string, alpha: number): string
    local a = math.clamp(alpha, 0, 1)
    if string.match(color, "^#%x%x%x%x%x%x$") then return color .. string.format("%02x", math.floor(a * 255 + 0.5)) end
    return color .. "/" .. string.format("%.2f", a)
end

local function report(what: string)
    return function(result: any)
        if result.exitCode ~= 0 or result.timedOut then
            noctalia.log("familiar: " .. what .. " failed: " .. (if result.stderr ~= "" then result.stderr else "exit " .. tostring(result.exitCode)))
        end
    end
end

-- One action, never retried against another workspace or index.
local function focus(id: string)
    noctalia.runAsync({ "familiar", "niri", "focus", id }, report("focus " .. id), 2000)
end

local function dismiss(ids: { string })
    local argv = { "familiar", "attention", "dismiss" }
    for _, id in ids do table.insert(argv, id) end
    noctalia.runAsync(argv, report("dismiss"), 2000)
end

local function noteArrivals(view: any, now: number)
    if view == nil then return end
    if known == nil then
        known = {}
        for id in view.episodes do known[id] = true end
        return
    end
    for id, episode in view.episodes do
        if not known[id] then
            known[id] = true
            if not episode.closed and not episode.dismissed then arrivals[id] = now end
        end
    end
end

local function pillNode(pill: any, motion: any): any
    local accent = pill.accent or "primary"
    local attended = pill.kind ~= nil
    local ids = P.dismissIds(pill)
    local width = if not attended then 0 elseif pill.kind == "needs-approval" then 2 else 1
    if motion.phase == "arrival" then width += 1 end
    local glow = if attended then 0.55 + 0.45 * motion.glow else 0
    local text = pill.label
    if pill.glyph then text ..= " " .. pill.glyph end
    if pill.count > 1 then text ..= " " .. pill.count end
    local button = {
        key = "ws-" .. pill.workspaceId, text = text,
        variant = if pill.focused then "primary" elseif pill.active then "secondary" elseif pill.occupied then "outline" else "ghost",
        selected = pill.focused, enabled = pill.navigable,
        tooltip = pill.tooltip or ("Workspace " .. pill.label),
        onClick = function() focus(pill.workspaceId) end,
    }
    if #ids > 0 then button.onRightClick = function() dismiss(ids) end end
    local children = { ui.button(button) }
    -- Native urgency is the application's, in the theme's colour, never familiar's.
    if pill.urgent then table.insert(children, ui.label({ key = "urgent-" .. pill.workspaceId, text = "•", color = "error" })) end
    if pill.withheld then table.insert(children, ui.label({ key = "withheld-" .. pill.workspaceId, text = "⧗", color = "outline" })) end
    return ui.row({
        key = "pill-" .. pill.workspaceId, radius = 6, paddingH = 1, gap = 1,
        border = withAlpha(accent, glow), borderWidth = width,
        fill = withAlpha(accent, if attended then 0.12 * glow else 0),
        opacity = if pill.stale then 0.5 else 1,
    }, children)
end

local function statusNode(key: string, text: string, color: string, tooltip: string): any
    return ui.row({ key = key, tooltip = tooltip }, { ui.label({ text = text, color = color }) })
end

-- Pills change only with shared state or output; their ages are refreshed on the
-- static cadence. Animation ticks reuse them and only recompute motion.
local cache: any = { at = -math.huge }

local function derived(now: number, view: any, trusted: boolean, mode: string): (any, any)
    if cache.navigation ~= navigation or cache.attention ~= attention or cache.output ~= output
        or now - cache.at >= P.STATIC_INTERVAL_MS then
        cache.pills = P.pillsFor(if trusted then view else nil, { workspaces = if navigation then navigation.rows else {} }, output, {
            now = now, attribution = trusted, navigable = mode ~= "unavailable", stale = mode == "unavailable",
        })
        cache.unseen = {}
        if view ~= nil then
            for id, episode in view.episodes do
                if not episode.seen then cache.unseen[id] = true end
            end
        end
        cache.navigation, cache.attention, cache.output, cache.at = navigation, attention, output, now
    end
    return cache.pills, cache.unseen
end

local function draw()
    local now = noctalia.nowMs()
    local view = attention and attention.view
    local mode = if navigation then navigation.mode else "unavailable"
    local healthy = attention ~= nil and attention.health ~= nil and attention.health.status == "healthy"
    local trusted = healthy and view ~= nil and mode == "feed"
    noteArrivals(view, now)
    local pills, unseen = derived(now, view, trusted, mode)
    local policy: any = { dnd = if view then view.desktop.dnd else "unknown", trusted = trusted, arrivals = arrivals, unseen = unseen }
    local next = P.STATIC_INTERVAL_MS
    local children = {}
    for _, pill in pills do
        local presentation = view and pill.winnerId and view.desktop.enrichment[pill.winnerId]
        policy.motion = (presentation and presentation.motionPolicy) or "full"
        local motion = P.animationFor(pill, now, policy)
        next = math.min(next, motion.interval)
        table.insert(children, pillNode(pill, motion))
    end
    if mode == "fallback" then
        table.insert(children, statusNode("status-nav", "↻", "outline", P.FEED_RECONNECTING_LABEL))
    elseif mode == "unavailable" then
        table.insert(children, statusNode("status-nav", "⊘", "error", P.NAVIGATION_UNAVAILABLE_LABEL))
    end
    -- A fault or a disconnection replaces the warnings below it; an unstable coordinator
    -- and an unknown DND status are separate warnings, shown side by side.
    local fault = attention and (attention.configError or attention.viewError)
    local blocked = fault or (attention ~= nil and attention.health.disconnected)
    if fault then
        table.insert(children, statusNode("status-health", "⚠", "error", fault))
    elseif attention ~= nil and attention.health.disconnected then
        table.insert(children, statusNode("status-health", "⚠", "error", P.DISCONNECTED_LABEL))
    end
    if not blocked and attention ~= nil and attention.health.unstable then
        -- Alerts still work between crashes; the ones arriving at a crash may be lost.
        table.insert(children, statusNode("status-unstable", "⚠", "outline", P.unstableLabel(attention.health.crashes)))
    end
    if not blocked and healthy and view ~= nil and view.desktop.dnd == "unknown" then
        -- Everything not yet shown is being held back, which a quiet bar would hide.
        table.insert(children, statusNode("status-dnd", "◐", "outline", P.DND_UNKNOWN_LABEL))
    end
    if trusted then
        -- Attention whose agent has no known workspace: explained here, never placed on a
        -- guessed pill. A dismissed diagnostic keeps its line, marked, without a glyph.
        local unmapped = P.attentionByWorkspace(view).unmapped
        local tooltip = P.groupTooltip(view, unmapped, now)
        if tooltip ~= nil then
            local active = unmapped.count > 0 or #unmapped.diagnosticIds > 0
            table.insert(children, statusNode("status-unmapped", if active then "◌" else "·", "outline",
                "No known workspace — open Alerts to review\n" .. tooltip))
        end
    end
    table.insert(children, ui.button({
        key = "alerts", text = "⚑", variant = "ghost", tooltip = "Agent alerts: review and dismiss per workspace",
        onClick = function() noctalia.togglePanel("khughitt/familiar:alerts") end,
    }))
    local container = if vertical then ui.column else ui.row
    barWidget.render(container({ key = "familiar-workspaces", gap = 4, align = "center" }, children))
    -- The timer restarts on every call, so it is only set when the cadence changes.
    if next ~= cadence then
        cadence = next
        noctalia.setUpdateInterval(next)
    end
end

-- Output and orientation exist only in a call's own snapshot: cache them here.
function update()
    output = barWidget.outputName()
    vertical = barWidget.isVertical()
    draw()
end

noctalia.state.watch("familiar/navigation", function(value: any)
    navigation = value
    draw()
end)
noctalia.state.watch("familiar/attention", function(value: any)
    attention = value
    draw()
end)
