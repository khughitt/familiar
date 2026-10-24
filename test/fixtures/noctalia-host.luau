-- A test-owned stand-in for Noctalia 5.3.0's Luau plugin host (src/scripting/luau_host.cpp,
-- plugin_bindings.cpp, plugin_widget.cpp and plugin_panel.cpp at v5.3.0), run under the
-- pinned Luau CLI. It reproduces what the plugin relies on: one environment ("VM") per
-- entry, callbacks looked up as globals, `require` of `./x.luau` with a per-VM cache and a
-- private module environment, JSON-shaped state shared only through noctalia.state (every
-- set notifies every watcher, delivered on a later turn), asynchronous reads and processes
-- delivered on a later turn with the host's limits, runAsync's enforced timeout and
-- trimmed output, setUpdateInterval's 16 ms floor and timer restart, and render trees.
-- Time is virtual: nothing happens until the driver advances it. Decoding is a lookup of
-- literals Node supplies for exact file bytes; nothing here re-implements the plugin.

local Host = {}
local sources = {}
local fixtures = {}

function __define(name: string, text: string)
    sources[name] = text
end

function __fixture(name: string, value: any)
    fixtures[name] = value
end

function fixture(name: string): any
    return fixtures[name]
end

-- ---------------------------------------------------------------- JSON out (to Node)

local function encode(value: any, depth: number?): string
    local d = depth or 0
    if d > 64 then error("encode: too deep") end
    local kind = type(value)
    if value == nil then return "null" end
    if kind == "boolean" then return if value then "true" else "false" end
    if kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then return "null" end
        if value == math.floor(value) and math.abs(value) < 2 ^ 53 then return string.format("%.0f", value) end
        return string.format("%.17g", value)
    end
    if kind == "string" then
        local escaped = string.gsub(value, '[%c"\\]', function(c)
            local named = ({ ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" })[c]
            return named or string.format("\\u%04x", string.byte(c))
        end)
        return '"' .. escaped .. '"'
    end
    if kind == "function" then return "null" end
    if kind == "table" then
        if #value > 0 then
            local parts = {}
            for i = 1, #value do parts[i] = encode(value[i], d + 1) end
            return "[" .. table.concat(parts, ",") .. "]"
        end
        local keys = {}
        for key in value do
            if type(key) == "string" then table.insert(keys, key) end
        end
        table.sort(keys)
        local parts = {}
        for _, key in keys do
            if type(value[key]) ~= "function" then table.insert(parts, encode(key) .. ":" .. encode(value[key], d + 1)) end
        end
        return "{" .. table.concat(parts, ",") .. "}"
    end
    error("encode: unsupported " .. kind)
end
Host.encode = encode

function emit(value: any)
    print("@@familiar-result@@" .. encode(value))
end

-- JSON's own null-dropping round trip, as noctalia.state stores values.
local function roundTrip(value: any): any
    if type(value) == "function" then return nil end
    if type(value) ~= "table" then return value end
    local copy = {}
    for key, item in value do
        if type(key) == "string" or type(key) == "number" then copy[key] = roundTrip(item) end
    end
    return copy
end

-- ---------------------------------------------------------------- virtual time

Host.now = 1000000
local queue = {}
local seq = 0

function Host.at(delay: number, fn: () -> ())
    seq += 1
    table.insert(queue, { at = Host.now + math.max(0, delay), seq = seq, fn = fn })
end

function Host.advance(ms: number)
    local target = Host.now + ms
    while true do
        local best, index = nil, nil
        for i, item in queue do
            if item.at <= target and (best == nil or item.at < best.at or (item.at == best.at and item.seq < best.seq)) then
                best, index = item, i
            end
        end
        if best == nil then break end
        table.remove(queue, index)
        Host.now = best.at
        best.fn()
    end
    Host.now = target
end

-- ---------------------------------------------------------------- the desktop around the host

Host.files = {}          -- path -> bytes (absent: cannot open)
Host.decoded = {}        -- exact bytes -> literal value
Host.env = {}            -- getenv
Host.readDelay = 10
Host.watchDelay = 0      -- modeled delay before a state change reaches a watching widget
Host.processes = {}      -- every argv the plugin ran, in order
Host.processHandler = function(_argv: { string }): any
    return { exitCode = 127, stdout = "", stderr = "not found" }
end
Host.notifications = {}
Host.panels = {}         -- togglePanel calls
Host.state = {}
local watchers = {}

-- ---------------------------------------------------------------- one VM per entry

local VM = {}
VM.__index = VM
Host.vms = {}

local function uiNode(kind: string)
    return function(props: any?, children: any?)
        return { type = kind, props = props or {}, children = children or {} }
    end
end

local UI = {}
for _, kind in { "column", "row", "box", "label", "glyph", "image", "separator", "spacer", "progress",
    "button", "graph", "markdown", "slider", "toggle", "dragSource", "dropZone" } do
    UI[kind] = uiNode(kind)
end

function Host.vm(name: string, entry: string, options: any?): any
    local opts = options or {}
    local vm = setmetatable({
        name = name, entry = entry, kind = opts.kind, output = opts.output, vertical = opts.vertical == true,
        interval = opts.interval or 250, updates = 0, updateTimes = {}, renders = 0, tree = nil,
        reads = 0, running = 0, modules = {}, alive = true, generation = 1, timerGeneration = 0,
        snapshot = true,
    }, VM)
    local env = setmetatable({}, { __index = getfenv(0) })
    vm.env = env
    -- The host's base library has no loadstring; the CLI's must not leak through.
    env.loadstring = function() error("loadstring is absent in the Noctalia host") end
    env.ui = UI
    env.noctalia = Host.noctaliaFor(vm)
    env.barWidget = {
        render = function(tree: any) vm:render(tree) end,
        isVertical = function() return vm.snapshot and vm.vertical or false end,
        outputName = function() return if vm.snapshot then vm.output else nil end,
        setTooltip = function(_tip: any) end,
    }
    env.panel = {
        render = function(tree: any) vm:render(tree) end,
        close = function() vm.open = false end,
        setWantsSecondTicks = function(on: boolean) vm.secondTicks = on end,
    }
    env.require = function(path: string): any return vm:require(path) end
    table.insert(Host.vms, vm)
    local chunk = assert(loadstring(assert(sources[entry], "no source " .. entry), "=" .. entry))
    setfenv(chunk, env)
    chunk()
    vm:call("update")
    vm:schedule()
    return vm
end

-- Module path rules as the host's: `./name.luau` against the plugin directory, cached,
-- private environment reading through to the entry's globals, one non-nil value.
function VM:require(path: string): any
    local name = string.match(path, "^%./([%w_%-]+)%.luau$")
    assert(name ~= nil, "require: unsupported path " .. path)
    if self.modules[name] ~= nil then return self.modules[name] end
    local moduleEnv = setmetatable({}, { __index = self.env })
    moduleEnv._G = moduleEnv
    local chunk = assert(loadstring(assert(sources[name], "no module " .. name), "=" .. name .. ".luau"))
    setfenv(chunk, moduleEnv)
    local value = chunk()
    assert(value ~= nil, "require: module returned nil")
    self.modules[name] = value
    return value
end

-- A callback with the call's snapshot (bar output and orientation). Return values ignored.
function VM:call(name: string, ...: any)
    local fn = rawget(self.env, name)
    if type(fn) ~= "function" or not self.alive then return end
    self.snapshot = true
    fn(...)
end

-- An asynchronous delivery: a later turn, with a default snapshot.
function VM:later(delay: number, fn: () -> ())
    local generation = self.generation
    Host.at(delay, function()
        if not self.alive or self.generation ~= generation then return end
        self.snapshot = false
        fn()
        self.snapshot = true
    end)
end

function VM:schedule()
    self.timerGeneration += 1
    local timerGeneration = self.timerGeneration
    local function tick()
        if not self.alive or timerGeneration ~= self.timerGeneration then return end
        if self.kind == "panel" and not (self.open and self.secondTicks) then
            Host.at(self.interval, tick)
            return
        end
        self.updates += 1
        table.insert(self.updateTimes, Host.now)
        self:call("update")
        Host.at(self.interval, tick)
    end
    Host.at(self.interval, tick)
end

function VM:render(tree: any)
    if type(tree) ~= "table" or type(tree.type) ~= "string" then return end
    local encoded = encode(tree)
    self.tree = tree
    if encoded ~= self.encodedTree then
        self.encodedTree = encoded
        self.renders += 1
        self.renderedAt = Host.now
    end
end

-- Find a node by its `key` prop in the current tree.
function VM:find(key: string): any
    local function walk(node: any): any
        if type(node) ~= "table" then return nil end
        if node.props and node.props.key == key then return node end
        for _, child in node.children or {} do
            local found = walk(child)
            if found then return found end
        end
        return nil
    end
    return walk(self.tree)
end

function VM:keys(prefix: string): { string }
    local found = {}
    local function walk(node: any)
        if type(node) ~= "table" then return end
        local key = node.props and node.props.key
        if type(key) == "string" and string.sub(key, 1, #prefix) == prefix then table.insert(found, key) end
        for _, child in node.children or {} do walk(child) end
    end
    walk(self.tree)
    return found
end

-- Tree callbacks get two strings, from the render that produced them.
function VM:click(key: string, prop: string?)
    local node = assert(self:find(key), "no node " .. key)
    local handler = node.props[prop or "onClick"]
    assert(type(handler) == "function", "node " .. key .. " has no " .. (prop or "onClick"))
    self.snapshot = true
    handler("", "")
end

function Host.noctaliaFor(vm: any): any
    local n = {}
    n.log = function(message: string) table.insert(Host.logs, vm.name .. ": " .. tostring(message)) end
    n.nowMs = function(): number return Host.now end
    n.getenv = function(name: string): string? return Host.env[name] end
    n.notify = function(title: string, body: string?) table.insert(Host.notifications, { at = Host.now, title = title, body = body }) end
    n.focusedOutputName = function(): string? return if vm.kind == "widget" then Host.focusedOutput else nil end
    n.getColor = function(role: string): string? return ({ primary = "#7aa2f7", on_surface = "#c0caf5", outline = "#565f89", error = "#f7768e", surface_variant = "#292e42", hover = "#3b4261" })[role] end
    n.togglePanel = function(id: string) table.insert(Host.panels, { at = Host.now, id = id }) end
    n.setUpdateInterval = function(ms: number)
        vm.interval = math.max(16, math.floor(ms))
        vm.intervalSets = (vm.intervalSets or 0) + 1
        vm:schedule()
    end
    n.json = {
        decode = function(text: string): (any, string?)
            local value = Host.decoded[text]
            if value == nil then return nil, "invalid json" end
            return roundTrip(value), nil
        end,
        encode = function(value: any): string return encode(value) end,
    }
    n.state = {
        set = function(key: string, value: any)
            Host.state[key] = roundTrip(value)
            for _, watcher in watchers[key] or {} do
                watcher.vm:later(Host.watchDelay, function() watcher.fn(roundTrip(Host.state[key])) end)
            end
        end,
        get = function(key: string): any return roundTrip(Host.state[key]) end,
        watch = function(key: string, fn: (any) -> ())
            watchers[key] = watchers[key] or {}
            table.insert(watchers[key], { vm = vm, fn = fn })
        end,
    }
    n.readFileAsync = function(path: string, cb: (string?, string?) -> ()): boolean
        if vm.reads >= 4 then return false end
        vm.reads += 1
        -- The bytes as of the request: the conservative case for a write landing mid-read.
        local bytes = Host.files[path]
        vm:later(Host.readDelay, function()
            vm.reads -= 1
            if bytes == nil then cb(nil, "cannot open file") else cb(bytes, nil) end
        end)
        return true
    end
    n.runAsync = function(argv: any, cb: any, timeoutMs: number?): boolean
        assert(type(argv) == "table", "runAsync: the plugin always passes an argument vector")
        for i = 1, #argv do assert(type(argv[i]) == "string" and #argv[i] > 0, "runAsync: argv entries must be non-empty strings") end
        assert(type(cb) == "function", "runAsync: callback required")
        if vm.running >= 8 then return false end
        local timeout = math.clamp(timeoutMs or 5000, 50, 60000)
        local record = { argv = table.clone(argv), at = Host.now, timeout = timeout, vm = vm.name }
        table.insert(Host.processes, record)
        vm.running += 1
        local outcome = Host.processHandler(record.argv)
        local delay = outcome.delay or 1
        local function trim(text: string?): string return (string.gsub(text or "", "[\r\n]+$", "")) end
        if delay > timeout then
            vm:later(timeout, function()
                vm.running -= 1
                cb({ exitCode = 143, stdout = "", stderr = "", timedOut = true, stdoutTruncated = false, stderrTruncated = false })
            end)
        else
            vm:later(delay, function()
                vm.running -= 1
                cb({ exitCode = outcome.exitCode or 0, stdout = trim(outcome.stdout), stderr = trim(outcome.stderr),
                    timedOut = false, stdoutTruncated = outcome.stdoutTruncated == true, stderrTruncated = false })
            end)
        end
        return true
    end
    return n
end

Host.logs = {}

-- A production module on its own, as `require` would load it in a fresh VM.
function Host.module(name: string): any
    local scratch = setmetatable({ modules = {}, env = setmetatable({ ui = UI }, { __index = getfenv(0) }) }, VM)
    return scratch:require("./" .. name .. ".luau")
end

function Host.widget(output: string, options: any?): any
    local opts = options or {}
    opts.output = output
    opts.kind = "widget"
    return Host.vm("widget:" .. output, "widget", opts)
end

function Host.service(): any
    return Host.vm("service", "service", { interval = 1000, kind = "service" })
end

-- A panel's VM is created on first open and survives closes.
function Host.openPanel(): any
    local panel = Host.panelVm
    if panel == nil then
        panel = Host.vm("panel", "panel", { interval = 1000, kind = "panel" })
        Host.panelVm = panel
    end
    panel.open = true
    panel:call("onOpen", "", "")
    return panel
end

