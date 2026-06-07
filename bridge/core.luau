--!strict
-- Pure bridge core. Factory takes env { typeof, datatypes, json, game, task, exec, Codec? }.
-- Returns ref tables, node builder, RPC handlers, and dispatch(raw)->replyString.
return function(env)
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

	-- ---- read/explore handlers ----------------------------------------
	local function encodeValue(v) return Codec.encode(v, encodeInstance) end

	local function readProp(inst, name)
		return pcall(function() return (inst :: any)[name] end)
	end

	-- curated per-class fallback when no propertyNames are supplied
	local UNIVERSAL = { "Name", "ClassName", "Parent" }
	local CLASS_PROPS = {
		BasePart = { "Anchored","Position","Size","CFrame","Color","Transparency","CanCollide","Material" },
		Model = { "PrimaryPart","WorldPivot" },
		Humanoid = { "Health","MaxHealth","WalkSpeed","JumpPower","DisplayName" },
		LuaSourceContainer = { "Source" },
		GuiObject = { "Visible","Position","Size","BackgroundColor3","BackgroundTransparency","ZIndex" },
		ValueBase = { "Value" },
	}
	local function fallbackNames(inst)
		local seen, out = {}, {}
		local function add(n) if not seen[n] then seen[n] = true; table.insert(out, n) end end
		for _, n in UNIVERSAL do add(n) end
		for class, names in CLASS_PROPS do
			local okIsA, isa = pcall(function() return inst:IsA(class) end)
			if okIsA and isa then for _, n in names do add(n) end end
		end
		-- richer set when the executor exposes getproperties()
		local gp = env.exec and env.exec.getproperties
		if type(gp) == "function" then
			local okGp, names = pcall(gp, inst)
			if okGp and type(names) == "table" then for _, n in names do add(n) end end
		end
		return out
	end

	local Handlers = {}

	function Handlers.status(_params)
		local exec = env.exec or {}
		return {
			gameName = game.Name,
			placeId = game.PlaceId or 0,
			clientVersion = "dex-bridge/0.1.0",
			capabilities = {
				hookmetamethod = type(exec.hookmetamethod) == "function",
				getrawmetatable = type(exec.getrawmetatable) == "function",
				getnamecallmethod = type(exec.getnamecallmethod) == "function",
				loadstring = type(exec.loadstring) == "function",
				getproperties = type(exec.getproperties) == "function",
			},
		}
	end

	function Handlers.getRoot(_params)
		local services = {}
		for _, child in game:GetChildren() do table.insert(services, buildNode(child)) end
		return { node = buildNode(game), services = services }
	end

	function Handlers.getChildren(params)
		local inst = resolve(params.ref)
		local out = {}
		for _, child in inst:GetChildren() do
			if (params.classFilter == nil) or (child.ClassName == params.classFilter) then
				table.insert(out, buildNode(child))
			end
		end
		return out  -- BARE array (frozen contract)
	end

	function Handlers.getProperties(params)
		local inst = resolve(params.ref)
		local names = params.propertyNames or fallbackNames(inst)
		local properties = {}
		-- UNIVERSAL ("Name","ClassName") always read OK -> `properties` is never an empty map.
		-- This matters: HttpService:JSONEncode encodes an empty table as [] (array), which would
		-- violate the Record<string,RobloxValue> contract for `properties`. Keep it non-empty.
		for _, name in names do
			local okRead, value = readProp(inst, name)
			if okRead and value ~= nil then properties[name] = encodeValue(value) end
		end
		return { className = inst.ClassName, properties = properties }
	end

	function Handlers.search(params)
		local limit = params.limit or 100
		local q = string.lower(params.query or "")
		local classFilter = params.classFilter
		-- Honor rootRef + maxDepth (spec §4/§8). When rootRef is nil/game and maxDepth is nil this
		-- walks every descendant of game's children — byte-identical to the mock, so the 34 tests hold.
		local rootInst = (params.rootRef ~= nil and resolve(params.rootRef)) or game
		local maxDepth = params.maxDepth  -- nil => unbounded; root's direct children = depth 1
		local out = {}
		-- depth = depth of `inst` relative to rootInst (rootInst's children are depth 1)
		local function visit(inst, depth)
			if #out >= limit then return end
			local nameHit = string.find(string.lower(inst.Name), q, 1, true) ~= nil
			if nameHit and (classFilter == nil or inst.ClassName == classFilter) then
				table.insert(out, buildNode(inst))
			end
			if maxDepth ~= nil and depth >= maxDepth then return end
			for _, child in inst:GetChildren() do
				if #out >= limit then return end
				visit(child, depth + 1)
			end
		end
		-- rootInst itself is excluded from matching (mock walks root.children)
		for _, child in rootInst:GetChildren() do
			if #out >= limit then break end
			visit(child, 1)
		end
		return out  -- BARE array
	end

	function Handlers.getByPath(params)
		local segs = string.split(params.path, ".")
		local cur = game
		for i = 2, #segs do  -- drop first segment ("game")
			local nextInst = cur:FindFirstChild(segs[i])
			if nextInst == nil then error("path not found: " .. params.path) end
			cur = nextInst
		end
		return buildNode(cur)  -- BARE node
	end

	function Handlers.getSource(params)
		local inst = resolve(params.ref)
		local okRead, src = readProp(inst, "Source")
		if (not okRead) or src == nil then error("instance has no readable source") end
		return { source = src }
	end

	function Handlers.setProperty(params)
		local inst = resolve(params.ref)
		local okCur, current = readProp(inst, params.name)
		local decoded = Codec.decode(params.value, params.valueType, okCur and current or nil, resolve)
		;(inst :: any)[params.name] = decoded
		return { ok = true }
	end

	local function decodeArgs(args)
		local out = {}
		for i, a in (args or {}) do out[i] = Codec.decode(a, nil, nil, resolve) end
		return out
	end

	function Handlers.fireRemote(params)
		local inst = resolve(params.ref)
		assert(inst:IsA("RemoteEvent"), "fire_remote expects a RemoteEvent")
		inst:FireServer(table.unpack(decodeArgs(params.args)))
		return { ok = true }
	end

	function Handlers.invokeRemote(params)
		local inst = resolve(params.ref)
		assert(inst:IsA("RemoteFunction"), "invoke_remote expects a RemoteFunction")
		local res = inst:InvokeServer(table.unpack(decodeArgs(params.args)))
		return { result = encodeValue(res) }  -- Instance returns use field `class`
	end

	-- ---- runLuau (executor loadstring + scoped print capture) ----------
	function Handlers.runLuau(params)
		local exec = env.exec or {}
		if type(exec.loadstring) ~= "function" then error("run_luau unsupported (no loadstring)") end
		local chunk, compileErr = exec.loadstring(params.code)
		if not chunk then return { output = tostring(compileErr) } end
		local buf = {}
		local function capture(...)
			local parts = {}
			for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
			table.insert(buf, table.concat(parts, "\t"))
		end
		if exec.setfenv then
			local base = (exec.getgenv and exec.getgenv()) or {}
			exec.setfenv(chunk, setmetatable({ print = capture, warn = capture }, { __index = base }))
		end
		local ok, ret = pcall(chunk)
		if not ok then table.insert(buf, "error: " .. tostring(ret)) end
		local result = { output = table.concat(buf, "\n") }
		if ok and ret ~= nil then result.returned = encodeValue(ret) end  -- primitives pass through raw
		return result
	end

	-- ---- remote spy (capability-gated; buffer + dump) ------------------
	local Spy = { active = false, buffer = {} }
	local function spyCapable()
		local e = env.exec or {}
		return type(e.hookmetamethod) == "function"
			and type(e.getrawmetatable) == "function"
			and type(e.getnamecallmethod) == "function"
			and type(e.newcclosure) == "function"
	end

	function Handlers.remoteSpyStart(_params)
		if not spyCapable() then error("remote spy unsupported by this executor") end
		if Spy.active then return { ok = true } end
		Spy.active = true
		local exec = env.exec
		local original
		original = exec.hookmetamethod(game, "__namecall", exec.newcclosure(function(self, ...)
			local method = exec.getnamecallmethod()
			if Spy.active and (method == "FireServer" or method == "InvokeServer") then
				-- read ClassName by DOT-INDEX (NOT a method) to avoid re-entering __namecall
				local okCls, cls = pcall(function() return self.ClassName end)
				if okCls and (cls == "RemoteEvent" or cls == "RemoteFunction") then
					-- store the raw instance; resolve path at DUMP time (outside the hook)
					table.insert(Spy.buffer, { instance = self, method = method, rawArgs = { ... } })
				end
			end
			return original(self, ...)  -- ALWAYS forward
		end))
		return { ok = true }
	end

	function Handlers.remoteSpyStop(_params)
		Spy.active = false  -- cannot cleanly unhook; gate via flag
		return { ok = true }
	end

	function Handlers.remoteSpyDump(_params)
		local entries = {}
		for _, e in Spy.buffer do
			local args = {}
			for i, a in e.rawArgs do args[i] = encodeValue(a) end
			table.insert(entries, { remote = dotPath(e.instance), args = args, method = e.method })
		end
		Spy.buffer = {}
		return { entries = entries }
	end

	-- ---- dispatch: {id,method,params} -> reply string ------------------
	Core.Handlers = Handlers
	function Core.dispatch(raw)
		local okDecode, msg = pcall(env.json.decode, raw)
		if not okDecode then
			return env.json.encode({ ok = false, error = "malformed request frame" })
		end
		local fn = Handlers[msg.method]
		if fn == nil then
			return env.json.encode({ id = msg.id, ok = false, error = "unknown method " .. tostring(msg.method) })
		end
		local okRun, result = pcall(fn, msg.params or {})
		if okRun then
			return env.json.encode({ id = msg.id, ok = true, result = result })
		end
		-- Lua's error() prepends "chunk:line: "; strip it so the message byte-matches the
		-- frozen mock strings (e.g. "stale ref 7", "path not found: x") the 34 server tests assert.
		local message = tostring(result):gsub("^[^\n]-:%d+: ", "")
		return env.json.encode({ id = msg.id, ok = false, error = message })
	end

	Core._internal = { refToInstance = refToInstance, instanceToRef = instanceToRef }
	return Core
end
