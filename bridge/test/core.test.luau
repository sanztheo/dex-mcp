--!strict
local Stubs = require("./stubs")
local makeCore = require("../core")
local checks = 0
local function check(a, e, m) Stubs.assertEq(a, e, m); checks += 1 end

local env = Stubs.makeEnv()
local core = makeCore(env)
local game = env.game

-- game is ref 0
check(core.refFor(game), 0, "game ref 0")
-- dedupe: same instance -> same ref
local ws = game._children[1]
local r1 = core.refFor(ws)
check(core.refFor(ws), r1, "dedupe ref")
-- resolve round-trips; unknown ref throws exact message
check(core.resolve(0), game, "resolve game")
local ok, err = pcall(core.resolve, 999)
check(ok, false, "resolve miss throws")
check(tostring(err):find("stale ref 999", 1, true) ~= nil, true, "exact stale-ref wording")

-- dotPath / buildNode
check(core.dotPath(ws), "game.Workspace", "dotPath")
local node = core.buildNode(ws)
check(node.name, "Workspace", "node name")
check(node.className, "Workspace", "node className")
check(node.path, "game.Workspace", "node path")
check(node.childCount, 2, "node childCount is number")

-- wire a codec into the env for the handler tests
local makeCodec = require("../codec")
local env2 = Stubs.makeEnv()
env2.Codec = makeCodec(env2)
local core2 = makeCore(env2)
local game2 = env2.game

-- helper: call dispatch with a request, decode the reply
local function call(method, params)
	local raw = env2.json.encode({ id = 1, method = method, params = params })
	return env2.json.decode(core2.dispatch(raw))
end

-- status
local s = call("status", {})
check(s.ok, true, "status ok")
check(s.result.gameName ~= nil, true, "status has gameName")
check(type(s.result.capabilities), "table", "status capabilities table")

-- getRoot: node ref 0 + services as BARE array of nodes
local root = call("getRoot", {})
check(root.result.node.ref, 0, "root ref 0")
check(root.result.node.className, "DataModel", "root className")
check(#root.result.services >= 2, true, "root services array")

-- getChildren: BARE Node[] (no wrapper)
local wsRef = root.result.services[1].ref
local children = call("getChildren", { ref = wsRef })
check(children.result[1] ~= nil, true, "getChildren bare array")

-- search: BARE Node[], name substring
local found = call("search", { query = "part" })
check(found.result[1].name, "Part", "search finds Part")

-- getByPath: BARE single node
local byPath = call("getByPath", { path = "game.Workspace.Part" })
check(byPath.result.name, "Part", "getByPath bare node")

-- getSource: ModuleScript Logic has source; Workspace does not -> error
local rsRef = root.result.services[2].ref
local logic = call("getChildren", { ref = rsRef })
local logicNode
for _, n in logic.result do if n.className == "ModuleScript" then logicNode = n end end
local src = call("getSource", { ref = logicNode.ref })
check(src.result.source, "return {}", "getSource ok")
local noSrc = call("getSource", { ref = wsRef })
check(noSrc.ok, false, "getSource error path")

-- unknown method -> error reply with id
local unk = call("frobnicate", {})
check(unk.ok, false, "unknown method error")
check(unk.id, 1, "error reply echoes id")

-- dispatch strips Lua's "chunk:line:" prefix so errors byte-match the frozen mock strings
check(unk.error, "unknown method frobnicate", "exact unknown-method string")
check(call("getByPath", { path = "game.Nope" }).error, "path not found: game.Nope", "exact path-not-found")
check(call("getProperties", { ref = 99999 }).error, "stale ref 99999", "exact stale-ref (prefix stripped)")

-- search honors maxDepth (only direct children of root) and rootRef (scoped subtree)
local shallow = call("search", { query = "", maxDepth = 1 })
local sn = {}
for _, n in shallow.result do sn[n.name] = true end
check(sn["Workspace"] == true and sn["Part"] == nil, true, "maxDepth=1 excludes deep Part")
local scoped = call("search", { query = "part", rootRef = root.result.services[1].ref })
check(scoped.result[1].name, "Part", "rootRef scopes search to Workspace")

-- getProperties on a Folder (not in CLASS_PROPS): UNIVERSAL fallback, non-empty map
local folder = call("getByPath", { path = "game.Workspace.Stuff" })
local fprops = call("getProperties", { ref = folder.result.ref })
check(fprops.result.properties.Name, "Stuff", "folder fallback includes Name")
check(fprops.result.properties.ClassName, "Folder", "folder fallback includes ClassName")

-- setProperty: decode + assign + {ok=true}
local partByPath = call("getByPath", { path = "game.Workspace.Part" })
local setRes = call("setProperty", { ref = partByPath.result.ref, name = "Name", value = "Renamed" })
check(setRes.result.ok, true, "setProperty ok=true")

-- fireRemote on the Buy RemoteEvent -> {ok=true}; mock-equivalent shape
local rsNode = call("getByPath", { path = "game.ReplicatedStorage" })
local buy = call("getChildren", { ref = rsNode.result.ref, classFilter = "RemoteEvent" })
local fired = call("fireRemote", { ref = buy.result[1].ref, args = {} })
check(fired.result.ok, true, "fireRemote ok=true")

-- invokeRemote on the Ping RemoteFunction (stub InvokeServer returns itself) -> {result=tagged Instance}
local ping = call("getChildren", { ref = rsNode.result.ref, classFilter = "RemoteFunction" })
local inv = call("invokeRemote", { ref = ping.result[1].ref, args = {} })
check(inv.result.result.__t, "Instance", "invokeRemote return is codec-encoded")
check(inv.result.result.class, "RemoteFunction", "invoke result Instance uses field `class`, not className")

-- remote spy hard-errors when executor capabilities are absent (env.exec is empty in tests)
local spy = call("remoteSpyStart", {})
check(spy.ok, false, "remoteSpyStart unsupported -> error")
check(spy.error, "remote spy unsupported by this executor", "spy unsupported exact wording (prefix stripped by dispatch)")

-- remoteSpyDump returns {entries=...} even before any capture (empty)
local dump = call("remoteSpyDump", {})
check(type(dump.result.entries), "table", "dump entries table")

-- runLuau compile error -> {output=<err>} via a stub loadstring
local env3 = Stubs.makeEnv()
env3.Codec = require("../codec")(env3)
env3.exec = { loadstring = function(code) return nil, "syntax error near X" end }
local core3 = makeCore(env3)
local raw = env3.json.encode({ id = 9, method = "runLuau", params = { code = "bad(" } })
local rl = env3.json.decode(core3.dispatch(raw))
check(rl.result.output, "syntax error near X", "runLuau compile error output")

return checks
