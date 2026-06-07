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

return checks
