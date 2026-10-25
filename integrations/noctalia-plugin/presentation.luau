--!strict
-- What the familiar workspace widget shows, as pure functions of the attention view,
-- the workspace feed and the clock. The service reads files; the widget and panel
-- draw; every decision about markers, health, navigation trust and motion is here.
-- The marker rules restate integrations/niri/attention.js (attentionByWorkspace); the
-- health rule restates src/attention/store.js (healthStatus). JSON null arrives as an
-- absent key, so every optional field is read as possibly nil.

local P = {}

P.APPROVAL_LABEL = "Approval requested — response unconfirmed"
P.DISCONNECTED_LABEL = "Agent alerts disconnected — toasts unavailable"
P.FEED_RECONNECTING_LABEL = "Workspace feed reconnecting"
P.NAVIGATION_UNAVAILABLE_LABEL = "Workspace navigation unavailable"
P.DISMISS_HINT = "Right-click to dismiss current alerts (requests in the agent are unaffected)"
P.CLAUDE_HINT = "Claude sub-agents share one session here: another sub-agent's activity can close this alert while its prompt is still open"
P.WITHHELD_LABEL = "Completion withheld — worker status unconfirmed"
P.DIAGNOSTIC_HINT = "Dismissing only hides this notice: the completion gate stays closed until the worker reports or the session ends, and a completion withheld meanwhile is not shown later"
P.DND_UNKNOWN_LABEL = "Do Not Disturb status unknown — toasts and popups are not shown, and are not replayed later"

P.HEALTH_STALE_MS = 10000
P.CRASH_WINDOW_MS = 600000
P.CRASH_HISTORY_MAX = 8
P.HEALTH_GRACE_MS = 10000
P.TOPOLOGY_STALE_MS = 2000
P.ARRIVAL_MS = 300
P.PULSE_PERIOD_MS = 4000
P.ARRIVAL_INTERVAL_MS = 16
P.PULSE_INTERVAL_MS = 200
P.STATIC_INTERVAL_MS = 2000

local KINDS = { ["needs-input"] = true, ["needs-approval"] = true, error = true, completion = true }
local PRIORITY = { error = 0, ["needs-approval"] = 1, ["needs-input"] = 2, completion = 3 }
local DELIVERY = {
    pending = true, eligible = true, reserved = true, delivered = true,
    failed = true, suppressed = true, interrupted = true, uncertain = true,
}
local GLYPH = { ["needs-input"] = "?", ["needs-approval"] = "!", error = "✕", completion = "✓" }
local LABEL = {
    ["needs-input"] = "Agent needs input",
    ["needs-approval"] = P.APPROVAL_LABEL,
    error = "Agent error",
    completion = "Turn finished",
}
local MAX_SAFE = 9007199254740991

local function isTable(value: any): boolean
    return type(value) == "table"
end

local function isText(value: any): boolean
    return type(value) == "string" and #value > 0
end

local function isDecimal(value: any): boolean
    return type(value) == "string" and (value == "0" or string.match(value, "^[1-9]%d*$") ~= nil)
end

local function isCount(value: any): boolean
    return type(value) == "number" and value >= 0 and value <= MAX_SAFE and value == math.floor(value)
end

-- `keys` lists every key the table may hold; anything else is an unknown field.
local function onlyKeys(value: { [string]: any }, keys: { string }): boolean
    local allowed = {}
    for _, key in keys do allowed[key] = true end
    for key in value do
        if not allowed[key] then return false end
    end
    return true
end

-- A crash history is a list of at most CRASH_HISTORY_MAX non-decreasing counts inside the
-- window ending at `writtenAt`. The JSON decoder hands back an empty list as an empty
-- table, so that is accepted; any other table must be a proper array.
local function validCrashes(crashed: any, writtenAt: number): boolean
    if not isTable(crashed) then return false end
    local length = 0
    for _ in crashed do length += 1 end
    if length > P.CRASH_HISTORY_MAX or length ~= #crashed then return false end
    for i = 1, length do
        local at = crashed[i]
        if not isCount(at) or at > writtenAt or at < writtenAt - P.CRASH_WINDOW_MS then return false end
        if i > 1 and at < crashed[i - 1] then return false end
    end
    return true
end

-- The health rule every consumer applies. A live identity that cannot be read is
-- unknown and never matches a saved one.
function P.healthStatus(health: any, live: { [string]: any }): string
    if health == nil then return "missing" end
    if not isTable(health) or not onlyKeys(health, { "schema", "instanceId", "epoch", "owner", "writtenAt", "stopped", "crashedAt" })
        or health.schema ~= 2 or not isText(health.instanceId) or #health.instanceId > 128
        or not isTable(health.epoch) or not onlyKeys(health.epoch, { "bootId", "desktopSession" })
        or (health.epoch.bootId ~= nil and not isText(health.epoch.bootId))
        or (health.epoch.desktopSession ~= nil and not isText(health.epoch.desktopSession))
        or not isTable(health.owner) or not onlyKeys(health.owner, { "pid", "start" })
        or not isCount(health.owner.pid) or health.owner.pid <= 0 or not isDecimal(health.owner.start)
        or not isCount(health.writtenAt) or type(health.stopped) ~= "boolean"
        or not validCrashes(health.crashedAt, health.writtenAt) then
        return "invalid"
    end
    if health.writtenAt > live.now then return "invalid" end
    if not isText(live.bootId) or not isText(live.desktopSession) or health.epoch.bootId ~= live.bootId
        or health.epoch.desktopSession ~= live.desktopSession
        or (live.instanceId ~= nil and health.instanceId ~= live.instanceId) then
        return "mismatched"
    end
    if live.now - health.writtenAt > P.HEALTH_STALE_MS then return "stale" end
    return "healthy"
end

-- The attention view as `familiar attention status` prints it, read strictly: an
-- unknown schema or a malformed required field rejects the whole view.
function P.validateView(view: any): (any, string?)
    if not isTable(view) or view.schema ~= 1 then return nil, "attention view: expected schema 1" end
    if not isTable(view.episodes) or not isTable(view.diagnostics) or not isTable(view.desktop)
        or not isTable(view.sources) then
        return nil, "attention view: missing sources, episodes, diagnostics or desktop"
    end
    for id, episode in view.episodes do
        if not isTable(episode) or episode.id ~= id or not KINDS[episode.kind] or not isCount(episode.order)
            or type(episode.seen) ~= "boolean" or type(episode.dismissed) ~= "boolean"
            or type(episode.closed) ~= "boolean" or not isText(episode.sourceKey)
            or (episode.rootKey ~= nil and not isText(episode.rootKey))
            or not isTable(episode.delivery) or not isTable(episode.delivery.popup)
            or not DELIVERY[episode.delivery.popup.status] or not isTable(episode.delivery.toast)
            or not DELIVERY[episode.delivery.toast.status] then
            return nil, "attention view: episode " .. tostring(id) .. " is malformed"
        end
    end
    for id, diagnostic in view.diagnostics do
        if not isTable(diagnostic) or diagnostic.id ~= id or not isText(diagnostic.rootKey)
            or not isTable(diagnostic.blockers) or type(diagnostic.dismissed) ~= "boolean" then
            return nil, "attention view: diagnostic " .. tostring(id) .. " is malformed"
        end
    end
    local desktop = view.desktop
    if not isTable(desktop.origins) or not isTable(desktop.workspaces) or not isTable(desktop.enrichment)
        or (desktop.dnd ~= "on" and desktop.dnd ~= "off" and desktop.dnd ~= "unknown")
        or (desktop.status ~= "known" and desktop.status ~= "unknown" and desktop.status ~= "disconnected") then
        return nil, "attention view: desktop is malformed"
    end
    return view, nil
end

-- The workspace feed (integrations/niri/topology.js), read strictly.
function P.validateTopology(topology: any): (any, string?)
    if not isTable(topology) or topology.schema ~= 1 or not isText(topology.instanceId)
        or not isCount(topology.revision) or not isCount(topology.writtenAt)
        or type(topology.connected) ~= "boolean" or not isTable(topology.epoch)
        or not isTable(topology.workspaces) then
        return nil, "workspace feed: malformed header"
    end
    local focused = 0
    for _, row in topology.workspaces do
        if not isTable(row) or not isDecimal(row.id) or not isCount(row.idx)
            or type(row.is_active) ~= "boolean" or type(row.is_focused) ~= "boolean"
            or type(row.is_urgent) ~= "boolean" or type(row.occupied) ~= "boolean"
            or (row.name ~= nil and not isText(row.name)) or (row.output ~= nil and not isText(row.output)) then
            return nil, "workspace feed: malformed workspace row"
        end
        if row.is_focused then focused += 1 end
    end
    if focused > 1 then return nil, "workspace feed: more than one focused workspace" end
    return topology, nil
end

-- Whether the feed may drive navigation now: fresh, from this boot and session, and
-- connected. Anything else sends the widget to its own read-only Niri query.
function P.topologyTrust(topology: any, live: { [string]: any }): string
    if topology == nil then return "missing" end
    local valid = P.validateTopology(topology)
    if valid == nil then return "invalid" end
    if not topology.connected then return "disconnected" end
    if topology.writtenAt > live.now then return "future" end
    if live.now - topology.writtenAt > P.TOPOLOGY_STALE_MS then return "stale" end
    if not isText(live.bootId) or not isText(live.desktopSession)
        or topology.epoch.bootId ~= live.bootId or topology.epoch.desktopSession ~= live.desktopSession then
        return "mismatched"
    end
    return "trusted"
end

-- A Niri `workspaces` reply as feed rows. IDs beyond 2^53 - 1 cannot be held exactly
-- and are refused rather than rounded into another workspace.
function P.rowsFromNiri(list: any): (any, string?)
    if not isTable(list) then return nil, "niri workspaces: not a list" end
    local rows = {}
    for _, workspace in list do
        if not isTable(workspace) or not isCount(workspace.id) or not isCount(workspace.idx)
            or type(workspace.is_active) ~= "boolean" or type(workspace.is_focused) ~= "boolean"
            or type(workspace.is_urgent) ~= "boolean" then
            return nil, "niri workspaces: malformed workspace"
        end
        local row = {
            id = string.format("%.0f", workspace.id), idx = workspace.idx,
            is_active = workspace.is_active, is_focused = workspace.is_focused, is_urgent = workspace.is_urgent,
            occupied = workspace.active_window_id ~= nil,
        }
        if isText(workspace.name) then row.name = workspace.name end
        if isText(workspace.output) then row.output = workspace.output end
        table.insert(rows, row)
    end
    return rows, nil
end

local function marked(episode: any): boolean
    return not episode.closed and not episode.dismissed
        and (episode.kind == "needs-input" or episode.kind == "needs-approval" or not episode.seen)
end

local function originOf(view: any, rootKey: string?): string?
    if rootKey == nil then return nil end
    local origin = view.desktop.origins[rootKey]
    return if origin ~= nil then origin.workspaceId else nil
end

-- Attention per workspace: the highest-priority marked episode wins (newest, then ID,
-- on ties); a count and the full ID lists keep every other one visible. Diagnostics sit
-- beside requests and are never counted. A completion is only marked where it is known
-- to have finished.
function P.attentionByWorkspace(view: any): any
    local workspaces = {}
    local unmapped = { count = 0, episodeIds = {}, diagnosticIds = {}, dismissedDiagnosticIds = {} }
    local ranked = {}
    for _, episode in view.episodes do
        if marked(episode) then table.insert(ranked, episode) end
    end
    table.sort(ranked, function(a, b)
        if PRIORITY[a.kind] ~= PRIORITY[b.kind] then return PRIORITY[a.kind] < PRIORITY[b.kind] end
        if a.order ~= b.order then return a.order > b.order end
        return a.id < b.id
    end)
    local function groupFor(workspaceId: string?): any
        if workspaceId == nil then return unmapped end
        if workspaces[workspaceId] == nil then
            workspaces[workspaceId] = { count = 0, episodeIds = {}, diagnosticIds = {}, dismissedDiagnosticIds = {} }
        end
        return workspaces[workspaceId]
    end
    for _, episode in ranked do
        local origin = originOf(view, episode.rootKey)
        if not (origin == nil and episode.kind == "completion") then
            local group = groupFor(origin)
            if origin ~= nil and group.winnerId == nil then
                group.kind = episode.kind
                group.winnerId = episode.id
            end
            group.count += 1
            table.insert(group.episodeIds, episode.id)
        end
    end
    -- A dismissed diagnostic loses its glyph, never its explanation.
    local diagnosticIds = {}
    for id in view.diagnostics do table.insert(diagnosticIds, id) end
    table.sort(diagnosticIds)
    for _, id in diagnosticIds do
        local diagnostic = view.diagnostics[id]
        local group = groupFor(originOf(view, diagnostic.rootKey))
        table.insert(if diagnostic.dismissed then group.dismissedDiagnosticIds else group.diagnosticIds, id)
    end
    return { workspaces = workspaces, unmapped = unmapped }
end

local function ageText(ms: number): string
    local seconds = math.max(0, math.floor(ms / 1000))
    if seconds < 60 then return seconds .. " s ago" end
    if seconds < 3600 then return math.floor(seconds / 60) .. " min ago" end
    return math.floor(seconds / 3600) .. " h ago"
end

local function episodeLine(view: any, id: string, now: number): string
    local episode = view.episodes[id]
    local source = view.sources[episode.sourceKey]
    local presentation = view.desktop.enrichment[id]
    local who = (presentation and presentation.project) or "agent session"
    if source ~= nil and source.scope == "worker" then
        who ..= " (worker " .. (string.match(source.agentId, "^[^:]+:(.+)$") or source.agentId) .. ")"
    end
    local line = LABEL[episode.kind] .. " — " .. who
    if source ~= nil and isCount(source.observedAt) and episode.kind == "needs-approval" then
        line ..= ", observed " .. ageText(now - source.observedAt)
    end
    if source ~= nil and source.harness == "claude-code" then line ..= "\n" .. P.CLAUDE_HINT end
    return line
end

local function diagnosticLine(view: any, id: string, now: number, dismissed: boolean): string
    local diagnostic = view.diagnostics[id]
    local parts = {}
    for _, key in diagnostic.blockers do
        local source = view.sources[key]
        if source ~= nil then
            table.insert(parts, source.agentId .. " " .. tostring(source.state) .. ", seen " .. ageText(now - source.observedAt))
        end
    end
    return P.WITHHELD_LABEL .. (if dismissed then " (dismissed)" else "") .. ": " .. table.concat(parts, "; ")
end

-- Every line a group of attention explains itself with: its episodes, its active and
-- dismissed diagnostics (a dismissed one stays, marked, since its gate is still closed),
-- and what dismissal does. Nil when the group has nothing to say.
function P.groupTooltip(view: any, group: any, now: number): string?
    local lines = {}
    for _, id in group.episodeIds do table.insert(lines, episodeLine(view, id, now)) end
    for _, id in group.diagnosticIds do table.insert(lines, diagnosticLine(view, id, now, false)) end
    for _, id in group.dismissedDiagnosticIds do table.insert(lines, diagnosticLine(view, id, now, true)) end
    if #group.diagnosticIds > 0 or #group.dismissedDiagnosticIds > 0 then table.insert(lines, P.DIAGNOSTIC_HINT) end
    if #group.episodeIds > 0 or #group.diagnosticIds > 0 then table.insert(lines, P.DISMISS_HINT) end
    return if #lines > 0 then table.concat(lines, "\n") else nil
end

-- Pills for one output, from fresh compositor rows. `attribution` is false whenever the
-- attention view or its coordinator is not trusted: then the rows still navigate, but
-- no familiar marker claims to know where an agent is.
function P.pillsFor(view: any, topology: any, outputName: string?, options: any?): { any }
    local opts = options or {}
    local now = opts.now or 0
    local rows = (topology and topology.workspaces) or {}
    local byWorkspace = if view ~= nil and opts.attribution ~= false then P.attentionByWorkspace(view).workspaces else {}
    local pills = {}
    for _, row in rows do
        if outputName == nil or row.output == outputName then
            local pill = {
                workspaceId = row.id, idx = row.idx, label = row.name or tostring(row.idx),
                active = row.is_active, focused = row.is_focused, urgent = row.is_urgent, occupied = row.occupied,
                navigable = opts.navigable ~= false, stale = opts.stale == true,
                episodeIds = {}, diagnosticIds = {}, count = 0,
            }
            local attention = byWorkspace[row.id]
            if attention ~= nil then
                pill.kind = attention.kind
                pill.winnerId = attention.winnerId
                pill.count = attention.count
                pill.episodeIds = table.clone(attention.episodeIds)
                pill.diagnosticIds = table.clone(attention.diagnosticIds)
                pill.glyph = if attention.kind then GLYPH[attention.kind] else nil
                if attention.winnerId then
                    local presentation = view.desktop.enrichment[attention.winnerId]
                    pill.accent = presentation and presentation.color or nil
                end
                pill.tooltip = P.groupTooltip(view, attention, now)
                pill.withheld = #attention.diagnosticIds > 0
            end
            table.insert(pills, pill)
        end
    end
    table.sort(pills, function(a, b) return a.idx < b.idx end)
    return pills
end

-- Exactly what was shown at the click: the episodes and diagnostics captured in the
-- pill, never "whatever is on that workspace" when the command later runs.
function P.dismissIds(pill: any): { string }
    local ids = table.clone(pill.episodeIds or {})
    for _, id in pill.diagnosticIds or {} do table.insert(ids, id) end
    return ids
end

-- Motion for one pill. A finite arrival (input, approval, error) the first time this
-- widget sees an episode after it started; then, for an unseen request, a slow
-- low-amplitude pulse; otherwise static. Reduced or off policy, DND not off, or an
-- untrusted coordinator means static distinctions only.
function P.animationFor(pill: any, now: number, policy: any): any
    local static = { phase = "static", interval = P.STATIC_INTERVAL_MS, scale = 1, glow = 0 }
    if pill.kind == nil or policy.motion ~= "full" or policy.dnd ~= "off" or not policy.trusted then return static end
    local arrivedAt = policy.arrivals and pill.winnerId and policy.arrivals[pill.winnerId]
    if arrivedAt ~= nil and pill.kind ~= "completion" and now - arrivedAt < P.ARRIVAL_MS then
        local t = (now - arrivedAt) / P.ARRIVAL_MS
        local strength = if pill.kind == "error" then 0.18 elseif pill.kind == "needs-approval" then 0.14 else 0.1
        return { phase = "arrival", interval = P.ARRIVAL_INTERVAL_MS, scale = 1 + strength * math.sin(math.pi * t), glow = 1 - t }
    end
    local unseen = policy.unseen and pill.winnerId and policy.unseen[pill.winnerId]
    if unseen and (pill.kind == "needs-input" or pill.kind == "needs-approval") then
        local t = (now % P.PULSE_PERIOD_MS) / P.PULSE_PERIOD_MS
        return { phase = "pulse", interval = P.PULSE_INTERVAL_MS, scale = 1, glow = 0.25 + 0.25 * math.sin(2 * math.pi * t) }
    end
    return static
end

return P
