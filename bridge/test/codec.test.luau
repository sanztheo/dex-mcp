--!strict
local Stubs = require("./stubs")
local makeCodec = require("../codec")
local env = Stubs.makeEnv()
local Codec = makeCodec(env)
local dt = env.datatypes
local checks = 0
local function check(actual, expected, msg) Stubs.assertEq(actual, expected, msg); checks += 1 end

-- a fake encodeInstance the codec calls for Instance values
local function encInst(inst) return { __t = "Instance", ref = 7, path = "game.X", class = inst.ClassName } end

-- primitives pass through
check(Codec.encode(42), 42, "number")
check(Codec.encode("hi"), "hi", "string")
check(Codec.encode(true), true, "bool")

-- finite() guards NaN/Inf
check(Codec.finite(0/0), 0, "nan")
check(Codec.finite(math.huge), 0, "inf")

-- tagged shapes EXACTLY match protocol.ts (lowercase keys)
check(Codec.encode(dt.Vector3.new(1,2,3)), { __t="Vector3", x=1, y=2, z=3 }, "vec3")
check(Codec.encode(dt.Color3.new(1,0,0)), { __t="Color3", r=1, g=0, b=0 }, "color3")
check(Codec.encode(dt.UDim2.new(0,100,0,50)),
	{ __t="UDim2", x={scale=0,offset=100}, y={scale=0,offset=50} }, "udim2")
check(Codec.encode(dt.CFrame.new(0,0,0, 1,0,0, 0,1,0, 0,0,1)),
	{ __t="CFrame", components={0,0,0,1,0,0,0,1,0,0,0,1} }, "cframe 12 components")
check(Codec.encode(dt.Enum.Material.Plastic),
	{ __t="EnumItem", enum="Material", name="Plastic", value=0 }, "enumitem enum-not-prefixed")

-- Instance delegates to encodeInstance (field is `class`, not className)
local fakeInst = { __type="Instance", ClassName="Part" }
check(Codec.encode(fakeInst, encInst), { __t="Instance", ref=7, path="game.X", class="Part" }, "instance via encInst")

return checks
