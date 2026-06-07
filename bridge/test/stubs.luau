--!strict
-- Test-only fakes so codec.luau / core.luau run under lune (no Roblox runtime).
-- typeof(v) recognizes our fake datatypes via a __type marker.
local serde = require("@lune/serde")

local Stubs = {}

-- ---- deep equality + assertions ----------------------------------------
local function deepEqual(a: any, b: any): boolean
	if type(a) ~= type(b) then return false end
	if type(a) ~= "table" then return a == b end
	for k, v in pairs(a) do if not deepEqual(v, b[k]) then return false end end
	for k in pairs(b) do if a[k] == nil then return false end end
	return true
end
Stubs.deepEqual = deepEqual

function Stubs.assertEq(actual: any, expected: any, msg: string?)
	if not deepEqual(actual, expected) then
		error(("assertEq failed%s\n  expected: %s\n  actual:   %s"):format(
			msg and (" ("..msg..")") or "",
			serde.encode("json", expected),
			serde.encode("json", actual)), 2)
	end
end

-- ---- fake datatypes ----------------------------------------------------
local function tagged(typeName: string, fields: {[string]: any})
	fields.__type = typeName
	return fields
end

local Vector3 = { new = function(x, y, z) return tagged("Vector3", {X=x, Y=y, Z=z}) end }
local Vector2 = { new = function(x, y) return tagged("Vector2", {X=x, Y=y}) end }
local Color3 = { new = function(r, g, b) return tagged("Color3", {R=r, G=g, B=b}) end }
local BrickColor = { new = function(name) return tagged("BrickColor", {Name=name}) end }
local UDim = { new = function(s, o) return tagged("UDim", {Scale=s, Offset=o}) end }
local UDim2 = { new = function(xs, xo, ys, yo)
	return tagged("UDim2", {X=tagged("UDim",{Scale=xs,Offset=xo}), Y=tagged("UDim",{Scale=ys,Offset=yo})})
end }
local CFrame = { new = function(...)
	local c = {...}
	local self = tagged("CFrame", {_c=c})
	function self.GetComponents() return table.unpack(c) end
	return self
end }

-- Enum proxy: Enum.Material.Plastic -> EnumItem; tostring(Enum.Material) -> "Material".
-- proxy is forward-declared so each EnumItem can back-link EnumType=proxy (the codec
-- reads tostring(item.EnumType) -> "Material"). Proxies are cached so FromValue finds items.
local function enumType(name)
	local items = {}
	local proxy
	proxy = setmetatable({}, {
		__index = function(_, itemName)
			if itemName == "FromValue" then
				return function(_, value)
					for _, it in items do if it.Value == value then return it end end
					return nil
				end
			end
			local it = items[itemName]
			if not it then
				it = tagged("EnumItem", {Name=itemName, Value=#items, EnumType=proxy})
				items[itemName] = it
			end
			return it
		end,
		__tostring = function() return name end,  -- tostring(Enum.Material) == "Material"
	})
	return proxy
end
local Enum = setmetatable({ _cache = {} }, { __index = function(self, enumName)
	local cache = rawget(self, "_cache")
	cache[enumName] = cache[enumName] or enumType(enumName)
	return cache[enumName]
end })

Stubs.datatypes = {
	Vector3 = Vector3, Vector2 = Vector2, Color3 = Color3, BrickColor = BrickColor,
	UDim = UDim, UDim2 = UDim2, CFrame = CFrame, Enum = Enum,
	-- NumberSequence/ColorSequence stubbed minimally (keypoints are z.any() in the schema)
	NumberSequence = { new = function(kp) return tagged("NumberSequence", {Keypoints=kp}) end },
	ColorSequence = { new = function(kp) return tagged("ColorSequence", {Keypoints=kp}) end },
}

function Stubs.typeof(v: any): string
	if type(v) == "table" and v.__type then return v.__type end
	return type(v)
end

Stubs.json = {
	encode = function(t) return serde.encode("json", t) end,
	decode = function(s) return serde.decode("json", s) end,
}

-- ---- fake DataModel tree (mirrors test/mock-bridge.ts fakeTree) ----------
-- Instance API used by core: .Name .ClassName .Parent :GetChildren() :FindFirstChild() :IsA() :GetFullName()
local function makeInstance(name: string, className: string, props: {[string]: any}?)
	local inst
	inst = {
		__type = "Instance",
		Name = name, ClassName = className, Parent = nil,
		_children = {}, _props = props or {},
	}
	function inst.GetChildren() return inst._children end
	function inst.FindFirstChild(_, childName)
		for _, c in inst._children do if c.Name == childName then return c end end
		return nil
	end
	function inst.IsA(_, klass) return inst.ClassName == klass end
	function inst.GetFullName()
		local trail, cur = {}, inst
		while cur do table.insert(trail, 1, cur.Name); cur = cur.Parent end
		return table.concat(trail, ".")
	end
	-- property access via index: core reads inst[name]; back it with _props + intrinsics
	return setmetatable(inst, { __index = function(_, k) return inst._props[k] end })
end

local function addChild(parent, child) child.Parent = parent; table.insert(parent._children, child) end

function Stubs.makeGame()
	local game = makeInstance("game", "DataModel")
	local ws = makeInstance("Workspace", "Workspace")
	local part = makeInstance("Part", "Part", { Anchored = false, Position = Vector3.new(0,5,0) })
	local folder = makeInstance("Stuff", "Folder")  -- class NOT in CLASS_PROPS -> exercises UNIVERSAL fallback
	addChild(ws, part); addChild(ws, folder)
	local rs = makeInstance("ReplicatedStorage", "ReplicatedStorage")
	local buy = makeInstance("Buy", "RemoteEvent")
	local ping = makeInstance("Ping", "RemoteFunction")  -- InvokeServer returns itself (see makeInstance)
	local logic = makeInstance("Logic", "ModuleScript", { Source = "return {}" })
	addChild(rs, buy); addChild(rs, ping); addChild(rs, logic)
	addChild(game, ws); addChild(game, rs)
	return game
end

-- Build a full env for makeCodec/makeCore.
function Stubs.makeEnv()
	return {
		typeof = Stubs.typeof,
		datatypes = Stubs.datatypes,
		json = Stubs.json,
		game = Stubs.makeGame(),
		task = { wait = function() end, spawn = function(fn) fn() end },
		exec = {}, -- no executor globals in tests (hookmetamethod etc. absent)
	}
end

return Stubs
