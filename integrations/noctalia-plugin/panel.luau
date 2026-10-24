--!strict
-- Panel entry `alerts`: every workspace's current alerts, with an explicit Dismiss per
-- workspace. It is the dismissal route that does not depend on right click. Dismissing
-- hides familiar's alerts only; it never answers a request or changes native urgency.

local P = require("./presentation.luau")

local function dismiss(ids: { string })
    if #ids == 0 then return end
    local argv = { "familiar", "attention", "dismiss" }
    for _, id in ids do table.insert(argv, id) end
    noctalia.runAsync(argv, function(result: any)
        if result.exitCode ~= 0 or result.timedOut then noctalia.log("familiar: dismiss failed: " .. result.stderr) end
    end, 2000)
end

local function section(key: string, title: string, lines: string, ids: { string }): any
    return ui.column({ key = "section-" .. key, gap = 4 }, {
        ui.label({ text = title, fontWeight = "bold" }),
        ui.label({ text = lines, maxLines = 12 }),
        ui.button({ key = "dismiss-" .. key, text = "Dismiss", variant = "outline", onClick = function() dismiss(ids) end }),
    })
end

local function render()
    local attention: any = noctalia.state.get("familiar/attention")
    local navigation: any = noctalia.state.get("familiar/navigation")
    local now = noctalia.nowMs()
    local children = { ui.label({ key = "title", text = "Agent alerts", fontWeight = "bold" }) }
    local view = attention and attention.view
    local healthy = attention ~= nil and attention.health.status == "healthy"
    if not healthy or view == nil then
        table.insert(children, ui.label({ key = "status", text = (attention and (attention.configError or attention.viewError)) or P.DISCONNECTED_LABEL }))
    else
        local rows = (navigation and navigation.rows) or {}
        local pills = P.pillsFor(view, { workspaces = rows }, nil, { now = now })
        for _, pill in pills do
            local ids = P.dismissIds(pill)
            if #ids > 0 then
                table.insert(children, section(pill.workspaceId, "Workspace " .. pill.label .. (if pill.output then " (" .. pill.output .. ")" else ""), pill.tooltip or "", ids))
            end
        end
        local unmapped = P.attentionByWorkspace(view).unmapped
        local ids = table.clone(unmapped.episodeIds)
        for _, id in unmapped.diagnosticIds do table.insert(ids, id) end
        if #ids > 0 then
            table.insert(children, section("unmapped", "No known workspace", tostring(#ids) .. " alert(s)", ids))
        end
        if #children == 1 then table.insert(children, ui.label({ key = "empty", text = "No current alerts" })) end
    end
    panel.render(ui.column({ key = "alerts", gap = 8, padding = 12 }, children))
end

function onOpen(_context: string, _extra: string)
    panel.setWantsSecondTicks(true)
    render()
end

function update()
    render()
end

noctalia.state.watch("familiar/attention", function() render() end)
noctalia.state.watch("familiar/navigation", function() render() end)
