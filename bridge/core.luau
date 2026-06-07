--!strict
-- Pure bridge core. Factory takes env { typeof, datatypes, json, game, task, exec, Codec? }.
-- Returns ref tables, node builder, RPC handlers, and dispatch(raw)->replyString.
return function(env)
	local typeof = env.typeof
	local game = env.game
	local Codec = env.Codec  -- set by callers before handlers run; ref/node tasks don't touch it

	local Core = {}

	-- ---- ref tables (weak both ways; game pinned at 0) ------------------
	local refToInstance = setmetatable({}, { __mode = "v" })
	local instanceToRef = setmetatable({}, { __mode = "k" })
	local nextId = 1
	instanceToRef[game] = 0
	refToInstance[0] = game

	local function refFor(inst)
		local existing = instanceToRef[inst]
		if existing ~= nil then return existing end
		local id = nextId
		nextId += 1
		instanceToRef[inst] = id
		refToInstance[id] = inst
		return id
	end
	Core.refFor = refFor

	local function resolve(ref)
		local inst = refToInstance[ref]
		if inst == nil then error(("stale ref %d"):format(ref)) end
		return inst
	end
	Core.resolve = resolve

	-- ---- dot path: walk .Parent up to game, join with "." -------------
	local function dotPath(inst)
		local trail, cur = {}, inst
		while cur ~= nil do
			table.insert(trail, 1, cur.Name)
			if cur == game then break end
			cur = cur.Parent
		end
		return table.concat(trail, ".")
	end
	Core.dotPath = dotPath

	local function buildNode(inst)
		return {
			ref = refFor(inst),
			name = inst.Name,
			className = inst.ClassName,
			path = dotPath(inst),
			childCount = #inst:GetChildren(),
		}
	end
	Core.buildNode = buildNode

	-- encodeInstance used by the codec for Instance-valued properties
	local function encodeInstance(inst)
		return { __t = "Instance", ref = refFor(inst), path = dotPath(inst), class = inst.ClassName }
	end
	Core.encodeInstance = encodeInstance

	-- handlers + dispatch added in later tasks.
	Core._internal = { refToInstance = refToInstance, instanceToRef = instanceToRef }
	return Core
end
