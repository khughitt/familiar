--!strict
-- Service entry `attention`: the one reader of familiar's files. It polls the workspace
-- feed every 50 ms and attention and its heartbeat every 250 ms, with at most one read
-- in flight per file and no subprocess for polling. When the feed is untrusted it asks
-- Niri directly, read-only, at most every 250 ms and never overlapping. It publishes
-- what the widgets and the panel draw through noctalia.state, only when it changed, and
-- sends the one health notice a disconnection or an unstable episode earns (checking DND
-- itself first).

local P = require("./presentation.luau")

local NAVIGATION = "familiar/navigation"
local ATTENTION = "familiar/attention"
local POLL_MS = 50
local SLOW_EVERY = 5
local FALLBACK_SPACING_MS = 250
local FALLBACK_CURRENT_MS = 2000
local NOTICE_SPACING_MS = 60000
-- A missing or mismatched heartbeat is also what a coordinator starting or restarting
-- looks like for a moment; only one that persists this long is a disconnection. A stale
-- heartbeat (over ten seconds) needs no such wait.
local CONFIRM_MS = 3000

local startedAt = noctalia.nowMs()
local desktopSession = noctalia.getenv("NIRI_SOCKET") or ""
local bootId = ""

-- Core's default, or an absolute override; anything else is refused, never resolved
-- against the plugin's directory.
local stateDir: string? = nil
local configError: string? = nil
do
    local override = noctalia.getenv("FAMILIAR_STATE_DIR")
    if override ~= nil then
        if string.sub(override, 1, 1) == "/" then stateDir = override
        else configError = "FAMILIAR_STATE_DIR must be an absolute path" end
    else
        local home = noctalia.getenv("HOME")
        if home ~= nil and string.sub(home, 1, 1) == "/" then stateDir = home .. "/.local/state/familiar"
        else configError = "HOME must be an absolute path" end
    end
end

local reading = { topology = false, attention = false, health = false }
local bytes: { [string]: string? } = {}
local topology: any = nil
local view: any = nil
local viewError: string? = nil
local healthRecord: any = nil
local healthInvalid = false
local tick = 0
local published: { [string]: string } = {}

-- The read-only fallback: generation changes whenever the feed becomes trusted again,
-- so a reply that started before cannot overwrite it.
local fallback = { inflight = false, startedAt = -math.huge, rows = nil :: any, at = -math.huge, failed = false }
local feedGeneration = 0
local feedTrusted = false
local lastRows: any = nil

local disconnected = false
local unhealthySince: number? = nil
local failureGeneration = 0
-- Unstable is the current reading (healthy, crashes at the threshold); the episode runs
-- from the first such healthy reading to the first healthy reading below it, and readings
-- that are not healthy (each restart passes through `mismatched`) leave it as it is.
local unstable = false
local unstableEpisode = false
local unstableGeneration = 0
-- Shared by both notices: at most one a minute, whichever asks.
local noticeAt = -math.huge

local function publish(key: string, value: any)
    local encoded = noctalia.json.encode(value)
    if published[key] == encoded then return end
    published[key] = encoded
    noctalia.state.set(key, value)
end

local evaluate: () -> ()

local function read(name: string, file: string, handle: (string?) -> ())
    if stateDir == nil or reading[name] then return end
    reading[name] = noctalia.readFileAsync(stateDir .. file, function(data: string?, _err: string?)
        reading[name] = false
        if data == bytes[name] then return end
        bytes[name] = data
        handle(data)
        evaluate()
    end)
end

local function decoded(data: string?): (any, boolean)
    if data == nil then return nil, false end
    local value = noctalia.json.decode(data)
    return value, value == nil
end

local function onTopology(data: string?)
    local value = decoded(data)
    topology = if value ~= nil then (P.validateTopology(value)) else nil
end

local function onAttention(data: string?)
    local value, broken = decoded(data)
    if data == nil then
        view, viewError = nil, nil
    elseif broken then
        view, viewError = nil, "attention.json: invalid json"
    else
        view, viewError = P.validateView(value)
    end
end

local function onHealth(data: string?)
    local value, broken = decoded(data)
    healthRecord, healthInvalid = value, broken
end

local function startFallback(now: number)
    if fallback.inflight or now - fallback.startedAt < FALLBACK_SPACING_MS then return end
    fallback.inflight = true
    fallback.startedAt = now
    local generation = feedGeneration
    local queued = noctalia.runAsync({ "niri", "msg", "-j", "workspaces" }, function(result: any)
        fallback.inflight = false
        if generation ~= feedGeneration or feedTrusted then return end
        local rows = nil
        if result.exitCode == 0 and not result.timedOut and not result.stdoutTruncated then
            rows = P.rowsFromNiri(noctalia.json.decode(result.stdout))
        end
        if rows ~= nil then
            fallback.rows, fallback.at, fallback.failed = rows, noctalia.nowMs(), false
            lastRows = rows
        else
            fallback.failed = true
        end
        evaluate()
    end, FALLBACK_CURRENT_MS)
    if not queued then fallback.inflight = false end
end

-- One notice per failure or unstable episode, at most one a minute across both, only
-- after an exact `off` from Noctalia's own DND query. A notice the minute or DND refuses
-- is dropped, never delayed; `current` drops a reply whose cause has since ended.
local function notice(now: number, body: string, current: () -> boolean)
    if now - noticeAt < NOTICE_SPACING_MS then return end
    noticeAt = now
    noctalia.runAsync({ "noctalia", "msg", "notification-dnd-status" }, function(result: any)
        if not current() then return end
        if result.exitCode == 0 and not result.timedOut and not result.stdoutTruncated and result.stdout == "off" then
            noctalia.notify("familiar", body)
        end
    end, 2000)
end

local function disconnectedNotice(now: number)
    local generation = failureGeneration
    notice(now, P.DISCONNECTED_LABEL, function() return generation == failureGeneration and disconnected end)
end

local function unstableNotice(now: number)
    local generation = unstableGeneration
    notice(now, P.UNSTABLE_NOTICE, function() return generation == unstableGeneration and unstableEpisode end)
end

function evaluate()
    local now = noctalia.nowMs()
    local live = { now = now, bootId = bootId, desktopSession = desktopSession }

    local trust = P.topologyTrust(topology, live)
    local navigation
    if trust == "trusted" then
        if not feedTrusted then feedGeneration += 1 end
        feedTrusted = true
        lastRows = topology.workspaces
        navigation = { mode = "feed", rows = topology.workspaces }
    else
        feedTrusted = false
        startFallback(now)
        if fallback.rows ~= nil and not fallback.failed and now - fallback.at <= FALLBACK_CURRENT_MS then
            navigation = { mode = "fallback", rows = fallback.rows }
        else
            navigation = { mode = "unavailable", rows = lastRows or {} }
        end
    end
    publish(NAVIGATION, navigation)

    local options: any = { now = now, bootId = bootId, desktopSession = desktopSession }
    if view ~= nil and view.desktop.instanceId ~= nil then options.instanceId = view.desktop.instanceId end
    local status = if healthInvalid then "invalid" else P.healthStatus(healthRecord, options)
    -- A heartbeat left from another boot or desktop session counts as missing during the
    -- startup grace: the new coordinator has not written its own yet.
    local transitional = status == "missing" or status == "mismatched"
    local starting = transitional and now - startedAt < P.HEALTH_GRACE_MS
    local unhealthy = status ~= "healthy" and not starting
    if not unhealthy then unhealthySince = nil
    elseif unhealthySince == nil then unhealthySince = now end
    local down = unhealthy and (not transitional or now - (unhealthySince :: number) >= CONFIRM_MS)
    if down ~= disconnected then
        disconnected = down
        failureGeneration += 1
        if down then disconnectedNotice(now) end
    end

    local crashes = if healthInvalid then nil else P.crashCount(healthRecord, live)
    unstable = status == "healthy" and crashes ~= nil and crashes >= P.UNSTABLE_CRASHES
    if status == "healthy" and unstable ~= unstableEpisode then
        unstableEpisode = unstable
        unstableGeneration += 1
        if unstable then unstableNotice(now) end
    end
    publish(ATTENTION, {
        view = view, viewError = viewError, configError = configError,
        health = { status = status, disconnected = down, crashes = crashes, unstable = unstable },
    })
end

function update()
    tick += 1
    read("topology", "/niri-workspaces.json", onTopology)
    if tick % SLOW_EVERY == 1 then
        read("attention", "/attention.json", onAttention)
        read("health", "/attention-health.json", onHealth)
    end
    evaluate()
end

noctalia.readFileAsync("/proc/sys/kernel/random/boot_id", function(data: string?, _err: string?)
    bootId = if data then (string.gsub(data, "%s+$", "")) else ""
    evaluate()
end)
noctalia.setUpdateInterval(POLL_MS)
